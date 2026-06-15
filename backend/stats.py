"""
Self-contained statistical helpers — no scipy required.
"""
import math


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction expansion for the regularised incomplete beta function."""
    FPMIN = 1e-30
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, 101):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 3e-7:
            break
    return h


def _betai(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta function I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    if x < (a + 1.0) / (a + b + 2.0):
        front = math.exp(math.log(x) * a + math.log(1.0 - x) * b - lbeta) / a
        return front * _betacf(a, b, x)
    front = math.exp(math.log(1.0 - x) * b + math.log(x) * a - lbeta) / b
    return 1.0 - front * _betacf(b, a, 1.0 - x)


def _t_pvalue_two_tailed(t_abs: float, df: float) -> float:
    """Two-tailed p-value for t-distribution."""
    x = df / (df + t_abs * t_abs)
    return _betai(df / 2.0, 0.5, x)


def _f_pvalue(f: float, df_between: int, df_within: int) -> float:
    """Approximate p-value for F-distribution using regularised incomplete beta."""
    x = df_between * f / (df_between * f + df_within)
    return 1.0 - _betai(df_between / 2.0, df_within / 2.0, x)


def one_way_anova(groups: list[list[float]]) -> tuple[float | None, float | None]:
    """
    One-way ANOVA across k groups.
    Returns (F_statistic, p_value) or (None, None) if insufficient data.
    """
    k = len(groups)
    groups = [g for g in groups if len(g) >= 2]
    if len(groups) < 2:
        return None, None
    N = sum(len(g) for g in groups)
    grand_mean = sum(sum(g) for g in groups) / N

    ss_between = sum(len(g) * (sum(g) / len(g) - grand_mean) ** 2 for g in groups)
    ss_within  = sum(sum((x - sum(g) / len(g)) ** 2 for x in g) for g in groups)

    df_between = k - 1
    df_within  = N - k
    if df_within < 1 or ss_within < 1e-14:
        return None, None

    ms_between = ss_between / df_between
    ms_within  = ss_within  / df_within
    f = ms_between / ms_within
    p = _f_pvalue(f, df_between, df_within)
    return round(f, 4), round(p, 6)


def one_sample_t_test(sample: list[float], mu: float) -> tuple[float | None, float | None]:
    """
    One-sample t-test: is sample mean different from mu?
    Returns (t_statistic, p_value_two_tailed) or (None, None) if n < 2.
    """
    n = len(sample)
    if n < 2:
        return None, None
    m = sum(sample) / n
    var = sum((x - m) ** 2 for x in sample) / (n - 1)
    if var < 1e-14:
        return None, None
    t = (m - mu) / math.sqrt(var / n)
    p = _t_pvalue_two_tailed(abs(t), n - 1)
    return round(t, 4), round(p, 4)
