# Options

期权策略可视化小工具

在线演示：[options.dmrml.cn](https://options.dmrml.cn)

---

人生里反复出现的几个词：interest、option、future。在日常英语里这是兴趣、选择、未来；放回金融语境，对应的恰好是利息、期权、远期合约。三类合约里，期权是最棘手的一类。

它把"权利"和"义务"分开计价。同样看涨一个标的，买入看涨期权、卖出看跌期权、直接持有现货，三种做法的损益结构差很远；多腿组合的复杂度还要再上一个台阶。把不同结构画在同一张图上做对比，比直接读公式直观。

这个仓库把这件事实现出来，方便金融工程或金融衍生品方向的设计与学习。在侧栏调市场参数，第一页用 Call、Put、现货、远期任意搭多腿组合，可以实时看到到期 P&L、希腊值随标的价格的变化、时间切片，以及组合损益在 (S, T) 平面上的三维曲面。

预设栏整理了 19 套常见组合（牛熊价差、跨式、铁鹰式、备兑、合成多空 等），可作为起点直接套用，再自行调整腿、观察曲线如何变化。

---

## 模型

**Black–Scholes 标准框架** —— 欧式权利、连续复利、无摩擦市场。

```
C = S·e^{-qT}·N(d₁) − K·e^{-rT}·N(d₂)
P = K·e^{-rT}·N(−d₂) − S·e^{-qT}·N(−d₁)
d₁ = [ln(S/K) + (r − q + σ²/2)·T] / (σ·√T)
d₂ = d₁ − σ·√T
```

**希腊值** —— Δ、Γ、ν、Θ、ρ 解析式实现，三维曲面网格采样 80 × 40。

**两档定价模式** ——

| 模式 | 说明 |
| ---- | ---- |
| 完整 BS | 用当前 r、q、σ 计算，贴近实盘场景 |
| 无贴现模式（默认） | r = q = 0，σ 仍正常生效。教科书首讲期权时的常见简化，便于把贴现影响和波动率影响切开来看 |

无贴现模式可以一键切回完整 BS，方便对比同一组合在两种假设下的差异。

---

## 功能

| 区块 | 内容 |
| ---- | ---- |
| 01 策略组合 | 多腿配置 + 到期 P&L 主图 |
| 02 关键指标 | 损益边界 / 五个希腊值 / 情景与策略画像 |
| 03 希腊值 | Δ Γ ν Θ ρ 五张曲线随 S 变化 |
| 04 时间切片 | P&L 在不同 T_remaining 截面对比 |
| 05 三维曲面 | 组合损益在 (S, T) 平面 |

19 套预设策略，按方向性 / 波动率多空 / 区间中性 / 组合现货 / 合成与套利分类。

支持账户登录后云端保存策略；匿名访问也能用全部计算功能，只是组合无法保存。

---

## 架构

- 后端：FastAPI + Uvicorn（端口 8001）
- 持久化：SQLite（WAL 模式）+ bcrypt + 签名 Cookie 会话（itsdangerous）
- 前端：原生 HTML / CSS / JavaScript + Plotly.js，无前端框架
- 部署：systemd + nginx + Let's Encrypt（独立子域名）

```
app/                  Python 后端
  routes/             API 路由（auth / pricing / strategies / pages）
  pricing.py          Black-Scholes 定价 + Greeks
  strategies.py       预设策略库 + payload 校验
  auth.py             认证（bcrypt + 签名 Cookie）
  db.py               SQLite 层
  config.py           配置 + secret 持久化
  main.py             FastAPI 入口
static/               静态资源（CSS / JS / Plotly / 字体）
templates/            Jinja2 模板
data/                 SQLite DB（运行时生成，已 gitignore）
scripts/              部署 + 备份 + nginx / systemd 配置
requirements.txt
```

---

## 本地运行

环境：Python 3.9 – 3.11

```bash
git clone https://github.com/ykkai-w/Options.git
cd Options
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
mkdir -p data logs
uvicorn app.main:app --port 8001 --reload
```

打开 http://127.0.0.1:8001 即可使用。首次访问会自动创建 `data/options.db` 和 `data/.session_key`，无需额外配置。

---

## 部署到服务器

```bash
cd /path/to/options-calc
python3 -m venv venv
./venv/bin/pip install -U pip
./venv/bin/pip install -r requirements.txt
mkdir -p logs data

sudo cp scripts/options-calc.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now options-calc

# nginx vhost 见 scripts/nginx-options.conf
# 数据库每日 04:00 自动备份（滚动保留 7 天）
chmod +x scripts/backup_db.sh
( crontab -l 2>/dev/null; echo "0 4 * * * /path/to/options-calc/scripts/backup_db.sh >> /path/to/options-calc/logs/backup.log 2>&1" ) | crontab -
```

---

## 风险提示

本工具基于 Black–Scholes 模型计算，假设欧式权利、连续复利、无摩擦市场，仅供学习与研究使用，不构成任何投资建议。

实盘期权定价与本工具结果会因保证金、滑点、流动性、波动率微笑、美式提前行权等因素存在差异。

---

## 许可证

MIT License. 见 [LICENSE](./LICENSE)。

---

## 关于

作者：Kai（CAU 金融学 & 数据科学 在读）
联系：ykai.w@outlook.com
主站：[dmrml.cn](https://dmrml.cn) —— DMR-ML 双重动量 + ML 风控的指数轮动策略
