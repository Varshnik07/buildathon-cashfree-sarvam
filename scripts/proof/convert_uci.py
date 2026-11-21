# Convert the UCI "Default of Credit Card Clients" file into our account format.
# Only behaviour that was known *before* the outcome month goes into the account;
# the outcome (paid next month or not) is kept separately for scoring the ranking afterwards.
# Usage: uv run --with pandas --with xlrd python scripts/proof/convert_uci.py <path-to-xls> <out.json>
import json, sys
import pandas as pd

src, out = sys.argv[1], sys.argv[2]
df = pd.read_excel(src, header=1).rename(columns={"PAY_0": "PAY_1", "default payment next month": "default"})
status = [f"PAY_{i}" for i in range(1, 7)]          # PAY_1 = most recent month
rows = []
for r in df.itertuples(index=False):
    s = [getattr(r, c) for c in status]
    partial = sum(1 for i in range(1, 6) if 0 < getattr(r, f"PAY_AMT{i}") < getattr(r, f"BILL_AMT{i+1}"))
    history = {"onTimeLast6": int(sum(1 for v in s if v <= 0)), "partialPays": partial}
    if s[0] > 0 and s[0] > s[2]:
        history["trend"] = "worsening"
    rows.append({
        "id": int(r.ID), "amountDue": max(int(r.BILL_AMT1), 0), "overdueDays": max(int(s[0]), 0) * 30,
        "history": history,
        "gender": {1: "male", 2: "female"}.get(int(r.SEX), "other"),
        "age": int(r.AGE),
        "paidNextMonth": int(r.default) == 0,
    })
json.dump(rows, open(out, "w"))
print(f"wrote {len(rows)} accounts to {out}")
