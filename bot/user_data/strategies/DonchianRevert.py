"""
DonchianRevert — BTC/USDT Binance USDT-M Futures, khung 15m, đánh hồi (mean reversion) 2 chiều.

Tín hiệu (xét khi nến 15m đóng cửa):
  - Donchian position = (close - đáy N nến) / (đỉnh N nến - đáy N nến), N = 20
  - LONG  khi Donchian pos <= 0.074 (≈ 5% thấp nhất)   — giá sát đáy kênh
  - SHORT khi Donchian pos >= 0.944 (≈ 5% cao nhất)    — giá sát đỉnh kênh
  - và ADX(14) > 30, Volume < trung bình 24h (96 nến), ATR(14) >= 0.4% giá
Quản lý lệnh:
  - 1R = 3 x ATR(14) của nến tín hiệu. SL ban đầu = -1R.
  - Khi lãi chạm +2R: trailing, cách đỉnh (đáy với Short) 1R.
  - Khối lượng: rủi ro 1% vốn mỗi lệnh (đòn bẩy tự tính, tối đa x5).
  - Tuỳ chọn: tp_r > 0 chốt lời cố định ở tp_r × R; trail_on = False tắt trailing.
Backtest (01/2021 → 09/2026, Bitstamp BTC/USD, --timeframe-detail 1m, phí 0.035%/chiều, funding 0.01%/8h):
  +84.9% tổng, ~11.3%/năm, max drawdown 15.1%, profit factor 1.24, 6/6 năm có lãi.

Mọi ngưỡng ở trên là tham số: giá trị mặc định nằm trong code, và có thể ghi đè bằng file
DonchianRevert.json đặt cạnh file này (trang "Chỉnh tham số" trong thư mục tuner/ ghi file đó).

KHÔNG phải lời khuyên đầu tư. Hãy chạy dry-run trước khi dùng tiền thật.
"""
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


class DonchianRevert(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"
    startup_candle_count = 200
    can_short = True
    minimal_roi = {"0": 100}          # không chốt lời cố định
    stoploss = -0.30                  # lưới an toàn; SL thật nằm trong custom_stoploss
    use_custom_stoploss = True
    use_custom_roi = True             # chốt lời cố định theo R (tp_r); tắt khi tp_r = 0
    use_exit_signal = False

    # --- Vào lệnh (space "buy")
    dc_period = IntParameter(10, 50, default=20, space="buy", optimize=False)
    dc_long = DecimalParameter(0.0, 0.3, default=0.074, decimals=3, space="buy", optimize=False)
    dc_short = DecimalParameter(0.7, 1.0, default=0.944, decimals=3, space="buy", optimize=False)
    adx_min = IntParameter(10, 50, default=30, space="buy", optimize=False)
    vol_max = DecimalParameter(0.3, 3.0, default=1.0, decimals=2, space="buy", optimize=False)
    atr_min_pct = DecimalParameter(0.0, 1.5, default=0.4, decimals=2, space="buy", optimize=False)
    short_enabled = BooleanParameter(default=True, space="buy", optimize=False)

    # --- Thoát lệnh và rủi ro (space "sell")
    r_atr = DecimalParameter(1.0, 6.0, default=3.0, decimals=1, space="sell", optimize=False)
    trail_start_r = DecimalParameter(0.5, 5.0, default=2.0, decimals=1, space="sell", optimize=False)
    trail_dist_r = DecimalParameter(0.1, 2.0, default=1.0, decimals=1, space="sell", optimize=False)
    trail_on = BooleanParameter(default=True, space="sell", optimize=False)
    tp_r = DecimalParameter(0.0, 10.0, default=0.0, decimals=1, space="sell", optimize=False)
    risk_pct = DecimalParameter(0.1, 3.0, default=1.0, decimals=2, space="sell", optimize=False)
    max_lev = IntParameter(1, 10, default=5, space="sell", optimize=False)
    # Bật khi chạy nhiều coin cùng lúc: luôn dùng max_lev để ký quỹ mỗi lệnh nhỏ (rủi ro/lệnh không đổi,
    # vì khối lượng vẫn tính theo 1R). Tắt = đòn bẩy tối thiểu cần thiết (mặc định, 1 coin).
    fixed_lev = BooleanParameter(default=False, space="sell", optimize=False)

    def populate_indicators(self, df: DataFrame, metadata: dict) -> DataFrame:
        hh = df["high"].rolling(self.dc_period.value).max()
        ll = df["low"].rolling(self.dc_period.value).min()
        df["dpos"] = (df["close"] - ll) / (hh - ll)
        df["adx"] = ta.ADX(df, timeperiod=14)
        df["vol_ratio"] = df["volume"] / df["volume"].rolling(96).mean()
        df["atr"] = ta.ATR(df, timeperiod=14)
        df["atr_pct"] = df["atr"] / df["close"] * 100
        return df

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        common = ((df["adx"] > self.adx_min.value) & (df["vol_ratio"] < self.vol_max.value)
                  & (df["atr_pct"] >= self.atr_min_pct.value) & (df["volume"] > 0))
        df.loc[common & (df["dpos"] <= self.dc_long.value), "enter_long"] = 1
        if self.short_enabled.value:
            df.loc[common & (df["dpos"] >= self.dc_short.value), "enter_short"] = 1
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        return df

    def _signal_atr(self, pair: str, at: datetime) -> float:
        """ATR của nến tín hiệu: nến 15m đã đóng ngay trước nến chứa thời điểm `at`.
        Cố định theo thời điểm vào lệnh, để khối lượng và 1R luôn dùng cùng một ATR
        (live có thể khớp trễ sang nến sau; backtest thì hai cách tính trùng nhau)."""
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
        if self.fixed_lev.value:
            return float(min(self.max_lev.value, max_leverage))
        r_pct = self._signal_atr(pair, current_time) * self.r_atr.value / current_rate
        need = self.risk_pct.value / 100 / r_pct
        return float(min(max(need, 1.0), self.max_lev.value, max_leverage))

    def custom_stake_amount(self, pair, current_time, current_rate, proposed_stake, min_stake,
                            max_stake, leverage, entry_tag, side, **kwargs) -> float:
        equity = self.wallets.get_total_stake_amount()
        r_pct = self._signal_atr(pair, current_time) * self.r_atr.value / current_rate
        return float(min(equity * self.risk_pct.value / 100 / r_pct / leverage, max_stake))

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                        current_profit: float, after_fill: bool, **kwargs):
        r = self._risk(pair, trade)
        start, dist = self.trail_start_r.value, self.trail_dist_r.value
        if not self.trail_on.value:
            start = float("inf")                       # chỉ còn SL ban đầu -1R
        if not trade.is_short:
            stop = trade.open_rate - r
            peak = max(trade.max_rate or trade.open_rate, current_rate)
            if peak >= trade.open_rate + start * r:
                stop = max(stop, peak - dist * r)
        else:
            stop = trade.open_rate + r
            trough = min(trade.min_rate or trade.open_rate, current_rate)
            if trough <= trade.open_rate - start * r:
                stop = min(stop, trough + dist * r)
        return stoploss_from_absolute(stop, current_rate, is_short=trade.is_short,
                                      leverage=trade.leverage)

    def custom_roi(self, pair: str, trade: Trade, current_time: datetime, trade_duration: int,
                   entry_tag, side: str, **kwargs):
        """Chốt lời khi giá đi được tp_r × R (ROI của freqtrade tính trên ký quỹ nên nhân đòn bẩy)."""
        if self.tp_r.value <= 0:
            return None
        return self.tp_r.value * self._risk(pair, trade) / trade.open_rate * trade.leverage
