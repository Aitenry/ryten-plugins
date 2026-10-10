#!/usr/bin/env python3
"""生成 `plugins/douyin-link/main/analysis/lexicon.generated.ts`（**通用情感词表**）。

## 为什么要生成，而不是手写
手工词表覆盖不了「不同人的打字风格」——同一个意思有几十种说法。所以通用层直接从公开词典导入，
人工只维护**直播领域层**（`lexicon.ts`：弹幕梗、点歌、带货、游戏、才艺、送礼话术…）。
运行时两层合并，领域层优先（同词冲突时以人工标注为准）。

## 数据来源 
1. **大连理工大学《情感词汇本体》**（林鸿飞等）——7 大类 21 小类，本项目的情感分类体系就是它。
   这里按大类取词：乐 / 好 / 怒 / 哀 / 惧 / 恶 / 惊。
2. **知网 HowNet《情感分析用词语集》**——正面情感 + 正面评价、负面情感 + 负面评价（作**纯极性**补充，
   因为 HowNet 不提供 7 大类归属），以及**程度级别词语**（极其 / 很 / 较 / 稍）与**否定词语**。

两份都以 [`cnsenti`](https://pypi.org/project/cnsenti/) 0.0.7（wheel 内含上述词典的 pickle）为分发载体；
两份的原始出处分别是 ir.dlut.edu.cn 与 keenage.com。

## 过滤规则（每条都对应一次真实的误判）
- **只收 2–6 个汉字**：单字通用情感词（`美`/`菜`/`差`/`重`）在直播间会被稳定误判
  （美杜莎 / 吃的菜 / 差两个），所以整类丢掉；长成语（`一头跌在菜刀上－切肤之痛`）弹幕里不会出现。
- **只要纯汉字**：DUTIR 里混着 `LOL`/`8错`/`NB`/`B4` 这类网络词与英文缩写。它们确实有用，
  但子串匹配会在英文/拼音里误命中，所以统一不收——真正常用的那几个（yyds/awsl/nsdd…）
  已经人工收在领域层里。
- **黑名单**：`问题`/`影响`/`情况`/`原因`/`造成`/`导致` 这类**高频中性词**一旦进表，
  整段弹幕会无差别地被判负，必须挡在外面。
- **去重与优先级**：同一词只保留第一次出现的类别（乐 → 好 → 怒 → 哀 → 惧 → 恶 → 惊），
  已被领域层人工标注过的词不再进通用层。
- **词频过滤**：以 jieba 主词典为词频表，只保留词频 ≥ `MIN_FREQ` 的词。词典里大量
  `一岁三迁` `三对六面` 这种生僻成语，用户根本不会打，留着只占体积。

用法：
    python scripts/gen-lexicon.py            # 自动下载 cnsenti（清华镜像）
    python scripts/gen-lexicon.py <wheel>    # 或用本地已下载的 wheel
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import urllib.request
import zipfile
import pickle
from urllib.parse import urljoin

# 7 大类（顺序即去重优先级，也是生成文件里的 key）
GROUPS = [
    ('joy', '乐'),
    ('like', '好'),
    ('anger', '怒'),
    ('sorrow', '哀'),
    ('fear', '惧'),
    ('disgust', '恶'),
    ('surprise', '惊'),
]

# 高频中性词黑名单：进表就会把整段弹幕无差别判负 / 判正。三类：
# 1) 书面中性词：`问题`/`影响`/`情况`/`原因`/`造成`/`导致`…
# 2) **功能词 / 否定词 / 语气词**：知网把它们标成了负面评价，但弹幕里几乎全是中性用法
#    （实测：「不是 有一个监控」「没有呀」会全被判负）；
# 3) **弹幕里的高频中性名词与称谓**：`情绪`/`确定`/`游戏`/`休息`/`关注`/`申请`/`少爷`/`老师`…
#    ——这些是靠「把真实语料里命中次数最多的词摊出来人工过一遍」找出来的，见
#    `main/analysis/text.ts` 的 `explainText()`（调词表时先用它看是哪个词干的）。
BLACKLIST = set(
    # 1 书面中性词
    '问题 影响 情况 原因 造成 导致 出现 发现 目前 可能 应该 需要 方面 关系 工作 生活 地方 东西 '
    '时间 时候 完全 进行 存在 发生 就是 已经 甚至 所以 但是 因为 如果 可以 一起 一点 一样 一直 一定 '
    '什么 怎么 为什么 多少 你们 我们 他们 这个 那个 自己 大家 知道 觉得 感觉 好像 必须 开始 结束 '
    '一般 普通 平常 基本 主要 重要 必要 容易 正常 及时 有没有 一下子 差不多 无所谓 没办法 不好 '
    # 2 功能词 / 否定词 / 语气词
    '不是 没有 不要 不用 不能 不会 不想 不要紧 还有 是不是 一点点 一下 没事 不了 不到 不知 '
    '哎呀 哎哟 唉 咦 呃 额 呵 嘿 哦 嗯 嘛 的话 非要 何必 何苦 还不如 不如 有点 什么的 '
    # 3 弹幕高频中性名词 / 称谓 / 动作
    '情绪 确定 少爷 老大 朋友 大白 游戏 休息 关注 点头 所谓 准备 说好 申请 小心 活动 拉屎 崽子 小崽子 '
    '老师 同学 哥哥 妹妹 姐姐 兄弟 姐妹 名字 事情 意思 样子 办法 电话 消息 照片 视频 直播 房间 '
    '手机 电脑 平时 下面 上面 里面 外面 后面 这里 那里 哪里 现在 以后 以前 '
    # 再一轮（第二轮摊高频命中词找出来的）
    '起来 升级 烟花 活着 刚刚 好好 拜拜 宿命 偷偷 气质 来了 走了 师傅 豪华 当然'.split()
)

CJK_WORD = re.compile(r'^[\u4e00-\u9fff]{2,6}$')
CJK_SHORT = re.compile(r'^[\u4e00-\u9fff]{1,3}$')
CJK_NEGATION = re.compile(r'^[\u4e00-\u9fff]{1,4}$')

WHEEL_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple/cnsenti/'
# 词频表（jieba 主词典）：用来丢掉「没人会打的书面词」。阈值越低留得越多、体积越大。
FREQ_URL = 'https://raw.githubusercontent.com/fxsjy/jieba/master/extra_dict/dict.txt.big'
MIN_FREQ = 10


def acquire_wheel(explicit: str | None) -> str:
    """拿到 cnsenti 的 wheel：给了路径就用，否则从清华镜像的 simple 索引里下。

    这里**不用 pip**：`sys.executable -m pip` 在部分 Python 发行版（例如某些软件自带的
    LibreOffice Python）下会直接 `PermissionError: [WinError 5]`，而直接抓索引 + 下文件
    只依赖标准库，任何 Python 3 都能跑。
    """
    if explicit:
        return explicit
    out = tempfile.mkdtemp(prefix='cnsenti-')
    print(f'下载 cnsenti → {out}')
    with urllib.request.urlopen(WHEEL_URL, timeout=60) as resp:
        html = resp.read().decode('utf-8', 'ignore')
    hrefs = re.findall(r'href="([^"]+\.whl)(?:#[^"]*)?"', html)
    if not hrefs:
        raise SystemExit(f'{WHEEL_URL} 里没找到 wheel，请手动下载后作为参数传入')
    url = urljoin(WHEEL_URL, hrefs[-1])
    dest = os.path.join(out, os.path.basename(url))
    urllib.request.urlretrieve(url, dest)
    return dest


def load_sets(wheel: str) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """解包 wheel，读出 DUTIR 七个大类与 HowNet 的几份词表。"""
    group_words: dict[str, list[str]] = {}
    hownet: dict[str, list[str]] = {}
    with zipfile.ZipFile(wheel) as z:
        for key, chinese in GROUPS:
            with z.open(f'cnsenti/dictionary/dutir/{chinese}.pkl') as f:
                data = pickle.load(f)
            group_words[key] = [w for w in data if isinstance(w, str)]
        for name in ('pos', 'neg', 'deny', 'extreme', 'very', 'more', 'ish'):
            with z.open(f'cnsenti/dictionary/hownet/{name}.pkl') as f:
                data = pickle.load(f)
            hownet[name] = [w for w in data if isinstance(w, str)]
    return group_words, hownet


def keep(word: str, freq: dict[str, int]) -> str | None:
    """通用层收词规则；不通过返回 None。"""
    word = word.strip()
    if not CJK_WORD.match(word) or word in BLACKLIST or word.endswith('的'):
        return None
    # 词频过滤：词频表里查不到 / 太少见的直接丢——`一岁三迁` `三对六面` 这种生僻成语
    # 用户根本不会打，留着只是白白占体积。拿不到词频表时跳过这层。
    if freq and freq.get(word, 0) < MIN_FREQ:
        return None
    return word


def load_freq() -> dict[str, int]:
    """jieba 主词典当作词频表用（约 58 万条 `词 词频 词性`）。"""
    try:
        import urllib.request

        with urllib.request.urlopen(FREQ_URL, timeout=60) as resp:
            text = resp.read().decode('utf-8', 'ignore')
    except Exception as exc:  # 离线也能生成，只是不过滤低频词
        print(f'词频表拿不到（{exc}），跳过低频词过滤')
        return {}
    freq: dict[str, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            try:
                freq[parts[0]] = int(parts[1])
            except ValueError:
                continue
    return freq


def main() -> None:
    wheel = acquire_wheel(sys.argv[1] if len(sys.argv) > 1 else None)
    group_words, hownet = load_sets(wheel)
    freq = load_freq()

    # 领域层已经人工标注过的词：不再重复进通用层
    here = os.path.dirname(os.path.abspath(__file__))
    curated_src = open(
        os.path.join(here, '..', 'plugins', 'douyin-link', 'main', 'analysis', 'lexicon.ts'),
        encoding='utf-8',
    ).read()
    curated = set(re.findall(r"'([^']{2,6})',\s*\d+\]", curated_src))

    categorized: dict[str, list[str]] = {key: [] for key, _ in GROUPS}
    taken: set[str] = set()
    for key, _ in GROUPS:
        for word in group_words[key]:
            word = keep(word, freq)
            if not word or word in taken or word in curated:
                continue
            taken.add(word)
            categorized[key].append(word)

    positive: list[str] = []
    negative: list[str] = []
    for word in hownet['pos']:
        word = keep(word, freq)
        if word and word not in taken and word not in curated:
            taken.add(word)
            positive.append(word)
    for word in hownet['neg']:
        word = keep(word, freq)
        if word and word not in taken and word not in curated:
            taken.add(word)
            negative.append(word)

    def pack(words: list[str]) -> str:
        return ' '.join(sorted(words))

    degree = {
        'extreme': [w.strip() for w in hownet['extreme'] if CJK_SHORT.match(w.strip())],
        'very': [w.strip() for w in hownet['very'] if CJK_SHORT.match(w.strip())],
        'more': [w.strip() for w in hownet['more'] if CJK_SHORT.match(w.strip())],
        'ish': [w.strip() for w in hownet['ish'] if CJK_SHORT.match(w.strip())],
        'deny': [w.strip() for w in hownet['deny'] if CJK_NEGATION.match(w.strip())],
    }

    lines: list[str] = [
        '/*',
        ' * 【自动生成，请勿手改】通用情感词表。',
        ' *',
        ' * 由 `scripts/gen-lexicon.py` 从公开词典生成：',
        ' * - 大连理工大学《情感词汇本体》（7 大类）：乐 / 好 / 怒 / 哀 / 惧 / 恶 / 惊',
        ' * - 知网 HowNet《情感分析用词语集》：正面词、负面词（纯极性）、程度级别（极其/很/较/稍）、否定词',
        ' * 分发载体：cnsenti 0.0.7（wheel 内含上述词典）。',
        ' *',
        ' * 运行时与人工维护的**领域层**（lexicon.ts）合并，领域层优先。',
        ' * 过滤规则（单字、非汉字、以「的」结尾、高频中性词与功能词黑名单、词频过低）见生成脚本注释。',
        ' */',
        '',
        '/** 7 大类情感词（空格分隔的紧凑存储；运行时 split 成表） */',
        'export const GENERATED_EMOTION = {',
    ]
    for key, _ in GROUPS:
        lines.append(f"  {key}: '{pack(categorized[key])}',")
    lines += [
        '}',
        '',
        '/** 知网正面词（不提供 7 大类归属，只参与正负极性） */',
        f"export const GENERATED_POSITIVE = '{pack(positive)}'",
        '',
        '/** 知网负面词（同上） */',
        f"export const GENERATED_NEGATIVE = '{pack(negative)}'",
        '',
        '/** 程度级别词语（知网四档：极其 / 很 / 较 / 稍） */',
        'export const GENERATED_DEGREE = {',
        f"  extreme: '{pack(sorted(set(degree['extreme'])))}',",
        f"  very: '{pack(sorted(set(degree['very'])))}',",
        f"  more: '{pack(sorted(set(degree['more'])))}',",
        f"  ish: '{pack(sorted(set(degree['ish'])))}'",
        '}',
        '',
        '/** 否定词语 */',
        f"export const GENERATED_NEGATION = '{pack(sorted(set(degree['deny'])))}'",
        '',
    ]

    target = os.path.join(
        here, '..', 'plugins', 'douyin-link', 'main', 'analysis', 'lexicon.generated.ts'
    )
    with open(target, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))

    total = sum(len(v) for v in categorized.values()) + len(positive) + len(negative)
    print(f'已写入 {target}')
    for key, _ in GROUPS:
        print(f'  {key:9s} {len(categorized[key])}')
    print(f'  positive  {len(positive)}')
    print(f'  negative  {len(negative)}')
    print(f'  total     {total}')


if __name__ == '__main__':
    main()
