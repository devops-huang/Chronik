#!/usr/bin/env python3
"""把 .tmp-i18n/{en,pt,zh}.json 深合并进 public/locales/*.json，并校验三语键集对齐。

用法：python3 tools/i18n-merge.py [--check]
  --check  只做键集校验，不写盘
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / "public" / "locales"
ADD = ROOT / ".tmp-i18n"
LANGS = ["en", "pt", "zh"]


def deep_merge(base: dict, extra: dict, path: str = "") -> list:
    """extra 覆盖 base；返回新增键路径列表。"""
    added = []
    for k, v in extra.items():
        p = f"{path}.{k}" if path else k
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            added += deep_merge(base[k], v, p)
        else:
            if k not in base:
                added.append(p)
            else:
                print(f"  ~ 覆盖已有键 {p}")
            base[k] = v
    return added


def flatten(d: dict, path: str = "") -> set:
    out = set()
    for k, v in d.items():
        p = f"{path}.{k}" if path else k
        if isinstance(v, dict):
            out |= flatten(v, p)
        else:
            out.add(p)
    return out


def main() -> int:
    check_only = "--check" in sys.argv
    loaded = {}
    for lang in LANGS:
        p = LOCALES / f"{lang}.json"
        loaded[lang] = json.loads(p.read_text(encoding="utf-8"))

    if not check_only:
        for lang in LANGS:
            frag = ADD / f"{lang}.json"
            if not frag.exists():
                print(f"跳过 {lang}（无增量文件）")
                continue
            extra = json.loads(frag.read_text(encoding="utf-8"))
            added = deep_merge(loaded[lang], extra)
            out = LOCALES / f"{lang}.json"
            out.write_text(json.dumps(loaded[lang], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{lang}: 新增/更新 {len(added)} 个键 → {out.relative_to(ROOT)}")

    # 键集对齐校验
    sets = {lang: flatten(loaded[lang]) for lang in LANGS}
    base = sets["en"]
    ok = True
    for lang in LANGS:
        miss = base - sets[lang]
        extra_keys = sets[lang] - base
        if miss:
            ok = False
            print(f"[✗] {lang} 缺少 {len(miss)} 个键：{sorted(miss)[:10]}")
        if extra_keys:
            ok = False
            print(f"[✗] {lang} 多出 {len(extra_keys)} 个键：{sorted(extra_keys)[:10]}")
    if ok:
        print(f"[✓] 三语键集一致，共 {len(base)} 个键")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
