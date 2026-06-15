dist = {1:149, 2:205, 3:249, 4:147, 5:110, 6:66, 7:24, 8:13, 9:6}
total = sum(dist.values())
K_vals = [3.0, 3.5, 4.0, 4.5, 5.0]

# Per-fight-count signal used (%) for each K
header = f"{'n':>2}  {'pop%':>5}  " + "  ".join(f"K={k:<3}" for k in K_vals)
print(header)
print("-" * len(header))
for n in range(1, 10):
    pct = dist[n]/total*100
    weights = [f"{n/(n+k)*100:>5.1f}%" for k in K_vals]
    print(f"{n:>2}  {pct:>4.1f}%  " + "  ".join(weights))

print()

# Summary stats per K
print(f"{'Stat':<35}" + "  ".join(f"K={k:<5}" for k in K_vals))
print("-" * 75)

# Median weight (n=3)
row = [f"{3/(3+k)*100:>6.1f}%" for k in K_vals]
print(f"{'Signal at median (n=3)':<35}" + "  ".join(row))

# Max weight (n=9)
row = [f"{9/(9+k)*100:>6.1f}%" for k in K_vals]
print(f"{'Signal at max (n=9)':<35}" + "  ".join(row))

# Ratio max/min (n=9 vs n=1)
row = [f"{(9/(9+k))/(1/(1+k)):>6.2f}x" for k in K_vals]
print(f"{'Reward ratio (n=9 vs n=1)':<35}" + "  ".join(row))

# Spread (n=9 weight - n=1 weight)
row = [f"{(9/(9+k) - 1/(1+k))*100:>6.1f}pp" for k in K_vals]
print(f"{'Spread (max-min, pp)':<35}" + "  ".join(row))

# Breakeven fight count (weight=50%)
row = [f"    n={k:.1f}" for k in K_vals]
print(f"{'Breakeven (50% signal)':<35}" + "  ".join(row))

# Breakeven percentile (what % of participant-years have >= breakeven n)
def pct_at_least(n_min):
    return sum(v for k,v in dist.items() if k >= n_min)/total*100
row = [f" {pct_at_least(k):>4.1f}%ile" for k in K_vals]
print(f"{'Breakeven percentile':<35}" + "  ".join(row))

# Weighted avg signal across actual distribution
def wavg(K):
    return sum(dist[n] * n/(n+K) for n in dist) / total * 100
row = [f"{wavg(k):>6.1f}%" for k in K_vals]
print(f"{'Weighted avg signal (real dist)':<35}" + "  ".join(row))
