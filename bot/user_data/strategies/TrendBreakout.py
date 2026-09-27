"""
TrendBreakout — nghiên cứu: đánh theo xu hướng (breakout kênh Donchian) 2 chiều, Binance USDT-M Futures.
Ý tưởng là bù cho DonchianRevert (đánh hồi): khi thị trường chạy một chiều dài, đánh hồi hay thua,
còn breakout thì ăn.

Tín hiệu (xét khi nến đóng cửa, khung theo config — nghiên cứu dùng 1h và 4h):
  - LONG  khi close > đỉnh cao nhất của `entry_period` nến TRƯỚC đó
  - SHORT khi close < đáy thấp nhất của `entry_period` nến trước đó
  - Tuỳ chọn ema_filter: chỉ long khi close > EMA200, chỉ short khi close < EMA200
Thoát lệnh:
  - SL ban đầu = r_atr × ATR(20) của nến tín hiệu (= 1R)
  - Thoát khi close thủng đáy (long) / vượt đỉnh (short) của `exit_period` nến trước đó
  - Khối lượng: rủi ro risk_pct % vốn mỗi lệnh, đòn bẩy nguyên làm tròn lên, tối đa max_lev

CHƯA dùng cho bot thật — chỉ để backtest (bot/research/trend.py).
"""
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


class TrendBreakout(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "4h"
    startup_candle_count = 250
    can_short = True
    minimal_roi = {"0": 100}
    stoploss = -0.50                  # lưới an toàn; SL thật nằm trong custom_stoploss
    use_custom_stoploss = True
    use_exit_signal = True

    entry_period = IntParameter(10, 100, default=20, space="buy", optimize=False)
    ema_filter = BooleanParameter(default=False, space="buy", optimize=False)
    short_enabled = BooleanParameter(default=True, space="buy", optimize=False)

    exit_period = IntParameter(5, 50, default=10, space="sell", optimize=False)
    r_atr = DecimalParameter(1.0, 6.0, default=2.0, decimals=1, space="sell", optimize=False)
    risk_pct = DecimalParameter(0.1, 3.0, default=1.0, decimals=2, space="sell", optimize=False)
    max_lev = IntParameter(1, 10, default=5, space="sell", optimize=False)
    fixed_lev = BooleanParameter(default=False, space="sell", optimize=False)

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
        if self.fixed_lev.value:
            return float(min(self.max_lev.value, max_leverage))
        r_pct = self._signal_atr(pair, current_time) * self.r_atr.value / current_rate
        need = math.ceil(self.risk_pct.value / 100 / r_pct - 1e-9)
        return float(min(max(need, 1), self.max_lev.value, math.floor(max_leverage)))

    def custom_stake_amount(self, pair, current_time, current_rate, proposed_stake, min_stake,
                            max_stake, leverage, entry_tag, side, **kwargs) -> float:
        equity = self.wallets.get_total_stake_amount()
        r_pct = self._signal_atr(pair, current_time) * self.r_atr.value / current_rate
        return float(min(equity * self.risk_pct.value / 100 / r_pct / leverage, max_stake))

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                        current_profit: float, after_fill: bool, **kwargs):
        r = self._risk(pair, trade)
        stop = trade.open_rate + r if trade.is_short else trade.open_rate - r
        return stoploss_from_absolute(stop, current_rate, is_short=trade.is_short, leverage=trade.leverage)
