"""
TrendBreakout — đánh theo xu hướng (breakout kênh Donchian) 2 chiều, Binance USDT-M Futures, khung 4h.
Chạy 5 coin thanh khoản cao nhất: BTC ETH SOL XRP DOGE (deploy/config.base.json).

Tín hiệu (xét khi nến đóng cửa):
  - LONG  khi close > đỉnh cao nhất của `entry_period` nến TRƯỚC đó, và close > EMA200 (ema_filter)
  - SHORT khi close < đáy thấp nhất của `entry_period` nến trước đó, và close < EMA200
Thoát lệnh:
  - SL ban đầu = r_atr × ATR(20) của nến tín hiệu (= 1R)
  - Thoát khi close thủng đáy (long) / vượt đỉnh (short) của `exit_period` nến trước đó
  - Khối lượng: rủi ro risk_pct % vốn mỗi lệnh; fixed_lev: luôn dùng max_lev để ký quỹ mỗi lệnh nhỏ
  - Live/dry-run: ngừng vào lệnh mới khi sụt vốn đã chốt > 25% (halt_on)
Backtest (freqtrade, 5 coin, 04/2020 → 09/2026, chi tiết 15m, phí + trượt 0.08%/chiều, rủi ro 0.25%, vốn 1000):
1470 lệnh (~19/tháng), thắng 32%, PF 1.55, lãi kép 20.5%/năm, max DD 11%, 7/7 năm lãi. 5 coin được chọn theo
thanh khoản hôm nay — trùng 5 coin tốt nhất trong research/robustness_trend_2026-10.md, nên số trên lạc quan
(10 coin: PF 1.33, DD 23%). Walk-forward, độ nhạy, chi phí: xem báo cáo đó.

Tham số mặc định nằm trong code; trang "Chỉnh tham số" của hub ghi đè bằng TrendBreakout.json cạnh file này.

KHÔNG phải lời khuyên đầu tư. Hãy chạy Demo/dry-run trước khi dùng tiền thật.
"""
import logging
import math
from datetime import datetime

import talib.abstract as ta
from pandas import DataFrame

from freqtrade.persistence import Trade
from freqtrade.strategy import (
    BooleanParameter,
    DecimalParameter,
    IntParameter,
    IStrategy,
    stoploss_from_absolute,
    timeframe_to_prev_date,
)

log = logging.getLogger(__name__)

# Chỉ xét sụt vốn: luật "PF < 1 sau 60 lệnh" của DonchianRevert dừng nhầm 42% số lần bắt đầu trong năm đầu
# (chiến lược thắng 32%, lãi theo cụm). 25% (02/10/2026): live chạy SL 3×ATR, rủi ro 1%/lệnh — backtest 5 coin vốn 500
# 2021→10/2026 max DD 23.7%, ngưỡng 15% sẽ dừng bot ở đợt sụt bình thường. Đổi cùng HALT_DD_PCT trong bot/hub/live.py.
HALT_DD = 0.25


def halt_reason(start: float, profits: list[float]) -> str | None:
    """Lý do dừng vào lệnh mới, None nếu chưa chạm ngưỡng. profits: lãi/lỗ USDT từng lệnh đã đóng, theo thứ tự đóng.
    DD tính trên cả lịch sử, nên đã chạm thì dừng hẳn tới khi người dùng tắt halt_on."""
    eq = peak = start
    dd = 0.0
    for p in profits:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
    return f"sụt vốn {dd:.1%} > {HALT_DD:.0%}" if dd > HALT_DD else None


class TrendBreakout(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "4h"
    startup_candle_count = 500               # EMA200 cần ~500 nến mới ổn định (recursive-analysis: 250 lệch 2%, 500 lệch 0.04%)
    can_short = True
    minimal_roi = {"0": 100}
    # Lưới an toàn tính trên ký quỹ (giá lệch 50%/đòn bẩy): đặt lên sàn trước, rồi custom_stoploss kéo về 1R.
    # Stop chỉ dời lại gần giá, nên leverage() giữ 1R × đòn bẩy < 90% mức này.
    stoploss = -0.50
    use_custom_stoploss = True
    use_exit_signal = True

    entry_period = IntParameter(10, 100, default=20, space="buy", optimize=False)
    ema_filter = BooleanParameter(default=True, space="buy", optimize=False)
    short_enabled = BooleanParameter(default=True, space="buy", optimize=False)

    exit_period = IntParameter(5, 50, default=10, space="sell", optimize=False)
    r_atr = DecimalParameter(1.0, 6.0, default=2.0, decimals=1, space="sell", optimize=False)
    risk_pct = DecimalParameter(0.1, 3.0, default=0.25, decimals=2, space="sell", optimize=False)
    max_lev = IntParameter(1, 10, default=5, space="sell", optimize=False)
    fixed_lev = BooleanParameter(default=True, space="sell", optimize=False)
    # Tự dừng vào lệnh mới (chỉ live/dry-run, backtest không đổi) khi chạm ngưỡng của halt_reason().
    halt_on = BooleanParameter(default=True, space="sell", optimize=False)

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self._pending_risk: dict[str, float] = {}      # 1R của lệnh vừa gửi, chờ khớp (order_filled)

    def populate_indicators(self, df: DataFrame, metadata: dict) -> DataFrame:
        n, m = self.entry_period.value, self.exit_period.value
        df["hh"] = df["high"].shift(1).rolling(n).max()
        df["ll"] = df["low"].shift(1).rolling(n).min()
        df["xh"] = df["high"].shift(1).rolling(m).max()
        df["xl"] = df["low"].shift(1).rolling(m).min()
        df["ema"] = ta.EMA(df, timeperiod=200)
        df["atr"] = ta.ATR(df, timeperiod=20)
        return df

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        up = df["close"] > df["hh"]
        down = df["close"] < df["ll"]
        if self.ema_filter.value:
            up &= df["close"] > df["ema"]
            down &= df["close"] < df["ema"]
        ok = df["volume"] > 0
        df.loc[ok & up, "enter_long"] = 1
        if self.short_enabled.value:
            df.loc[ok & down, "enter_short"] = 1
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[df["close"] < df["xl"], "exit_long"] = 1
        df.loc[df["close"] > df["xh"], "exit_short"] = 1
        return df

    def _signal_atr(self, pair: str, at: datetime) -> float:
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        df = df.loc[df["date"] < timeframe_to_prev_date(self.timeframe, at)]
        return float(df["atr"].iloc[-1])

    def _risk(self, pair: str, trade: Trade) -> float:
        r = trade.get_custom_data("risk")
        if r is None:
            r = self._signal_atr(pair, trade.open_date_utc) * self.r_atr.value
            trade.set_custom_data("risk", r)
        return r

    def leverage(self, pair, current_time, current_rate, proposed_leverage, max_leverage,
                 entry_tag, side, **kwargs) -> float:
        r_pct = self._signal_atr(pair, current_time) * self.r_atr.value / current_rate
        cap = max(1, math.floor(0.9 * abs(self.stoploss) / r_pct))
        if self.fixed_lev.value:
            return float(min(self.max_lev.value, math.floor(max_leverage), cap))
        need = math.ceil(self.risk_pct.value / 100 / r_pct - 1e-9)
        return float(min(max(need, 1), self.max_lev.value, math.floor(max_leverage), cap))

    def custom_stake_amount(self, pair, current_time, current_rate, proposed_stake, min_stake,
                            max_stake, leverage, entry_tag, side, **kwargs) -> float:
        equity = self.wallets.get_total_stake_amount()
        risk = self._signal_atr(pair, current_time) * self.r_atr.value
        self._pending_risk[pair] = risk              # order_filled lưu lại vào lệnh
        return float(min(equity * self.risk_pct.value / 100 / (risk / current_rate) / leverage, max_stake))

    def confirm_trade_entry(self, pair, order_type, amount, rate, time_in_force, current_time,
                            entry_tag, side, **kwargs) -> bool:
        if not self.halt_on.value or self.dp.runmode.value not in ("live", "dry_run"):
            return True
        closed = sorted(Trade.get_trades_proxy(is_open=False), key=lambda t: t.close_date_utc)
        why = halt_reason(self.wallets.get_starting_balance(), [t.close_profit_abs or 0.0 for t in closed])
        if why:
            # ERROR: watchdog của hub (alerts.py) đẩy dòng này về điện thoại
            log.error("DỪNG VÀO LỆNH MỚI: %s — bỏ tín hiệu %s %s. Xem lại rồi tắt halt_on để chạy tiếp.",
                      why, pair, side)
            return False
        return True

    def order_filled(self, pair: str, trade: Trade, order, current_time: datetime, **kwargs) -> None:
        """Lưu 1R vào lệnh ngay khi lệnh vào khớp, để stop trên sàn đúng 1R kể cả khi bot vừa khởi động lại."""
        if order.ft_order_side != trade.entry_side or trade.get_custom_data("risk") is not None:
            return
        r = self._pending_risk.pop(pair, None)
        if r is None:
            try:
                r = self._signal_atr(pair, trade.open_date_utc) * self.r_atr.value
            except (IndexError, KeyError):
                return                                   # chưa có nến: custom_stoploss tính sau
        trade.set_custom_data("risk", r)

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                        current_profit: float, after_fill: bool, **kwargs):
        r = self._risk(pair, trade)
        stop = trade.open_rate + r if trade.is_short else trade.open_rate - r
        return stoploss_from_absolute(stop, current_rate, is_short=trade.is_short, leverage=trade.leverage)
