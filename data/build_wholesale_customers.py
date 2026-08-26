#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卸の得意先マスタ・商品×得意先の対応表・得意先グループの初期並び順を、
wholesale_customer_product_source.json から app_master_data.json にマージするスクリプト。

wholesale_customer_product_source.json は、得意先別の販売実績表（PDF/Excelなど）から
書き起こした「得意先コード・得意先名・[商品コード・商品名・年間売上数量]」のデータです。
このスクリプトは書き起こし内容をそのまま信頼してマージするので、内容が正しいことは
別途（例えば app_master_data.json の wholesaleProducts.annualQty との突き合わせで）
確認してから実行してください。

使い方:
    python3 build_wholesale_customers.py

出力（app_master_data.json に上書きマージ）:
    "wholesaleCustomers": [ {code, name}, ... ]
    "wholesaleProductCustomers": { "<商品コード>": [ {code: 得意先コード, qty}, ... ]（数量降順） }
    "wholesaleGroupOrder": [ 得意先コード, ... ]（合計数量降順・初期の並び順）

送料・箱代・サンプル等、実際の商品ではない行は PSEUDO_CODES として自動的に除外されます。
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
MASTER_PATH = HERE / "app_master_data.json"
SOURCE_PATH = HERE / "wholesale_customer_product_source.json"

# 商品ではない行（送料・箱代・返品送料・サンプルなど）のコード。得意先ごとの対応表からは除外する。
PSEUDO_CODES = {"1", "000900004", "000901500", "001110004", "060000000", "060000002", "080000009"}


def main():
    customers = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
    master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
    wholesale_codes = set(p["code"] for p in master["wholesaleProducts"])

    wholesale_customers = []
    product_customers = {}
    customer_totals = {}

    unknown_codes = {}
    for ccode, cname, items in customers:
        wholesale_customers.append({"code": ccode, "name": cname})
        total = 0
        for pcode, pname, qty in items:
            if pcode in PSEUDO_CODES:
                continue
            if pcode not in wholesale_codes:
                unknown_codes.setdefault(pcode, pname)
                continue
            product_customers.setdefault(pcode, []).append({"code": ccode, "qty": qty})
            total += qty
        customer_totals[ccode] = total

    for pcode in product_customers:
        product_customers[pcode].sort(key=lambda x: -x["qty"])

    wholesale_group_order = sorted(customer_totals.keys(), key=lambda c: -customer_totals[c])

    # 商品ごとの「主な取引先」（最も数量の多い得意先）を wholesaleProducts に付与する
    # （通販の retailProducts.group と同じ考え方で、取引先ごとのグループ分け表示に使う）
    for p in master["wholesaleProducts"]:
        entries = product_customers.get(p["code"])
        p["customerCode"] = entries[0]["code"] if entries else None

    master["wholesaleCustomers"] = wholesale_customers
    master["wholesaleProductCustomers"] = product_customers
    master["wholesaleGroupOrder"] = wholesale_group_order

    MASTER_PATH.write_text(
        json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    missing = wholesale_codes - set(product_customers.keys())
    print(f"得意先数: {len(wholesale_customers)}")
    print(f"対応付けできた商品数: {len(product_customers)} / {len(wholesale_codes)}")
    if missing:
        print(f"※どの得意先にも紐付かなかった商品（{len(missing)}件）: {sorted(missing)}")
    if unknown_codes:
        print(f"※現在のマスタに無いコード（除外しました。{len(unknown_codes)}件）:")
        for c, n in unknown_codes.items():
            print(f"    {c}  {n}")
    print("app_master_data.json を更新しました。")


if __name__ == "__main__":
    main()
