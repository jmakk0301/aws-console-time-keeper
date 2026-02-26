# AWS Console URL パターン解析記録

AWS Console Time Keeper を開発する中で発見した、AWSコンソール各サービスの時間範囲URLエンコーディングの全記録。

---

## TL;DR

AWSコンソールは **サービスごとに時間範囲のURL表現がバラバラ** で、少なくとも5つの異なるエンコーディング方式が存在する。

| # | サービス画面 | エンコーディング | 時間の表現 |
|---|-------------|-----------------|-----------|
| 1 | CloudWatch Metrics | JSURL (hash内) | ISO 8601 duration / absolute ISO |
| 2 | CloudWatch Home / Dashboards | JSURL (hash内) | 相対ミリ秒 / absolute object |
| 3 | CloudWatch Logs Insights (Format A) | JSURL → encodeURIComponent → `%`→`$` | 相対秒数 / epoch秒 |
| 4 | CloudWatch Logs Insights (Format B) | `?`=`$3F`, `=`=`$3D` + 生JSURL | 相対秒数 / epoch秒 |
| 5 | CloudWatch Log Events | `?`=`$3F`, `=`=`$3D` + plain params | 相対ミリ秒 / epoch ミリ秒 |
| 6 | X-Ray | プレーンクエリパラメータ | ISO 8601 duration / `START~END` |
| - | ALB Monitoring 等 | URLに時間情報なし | N/A |

---

## Pattern 1: CloudWatch Home / Dashboards — JSURL ハッシュステート

### 発見した URL

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #home:?~(timeRange~1814400000)
```

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #home:dashboards/ApplicationELB?~(timeRange~43200000)
```

### 構造

```
#<section>:<path>?~(<JSURL state>)
```

`?` 以降が JSURL エンコードされた状態オブジェクト。`timeRange` フィールドに時間範囲が入る。

### エンコーディング

[JSURL](https://github.com/Sage/jsurl) (Sage/jsurl, MIT) というコンパクトなURL向けJSONエンコーディング。

```
~(timeRange~1814400000)
  ↓ JSURL decode
{ timeRange: 1814400000 }
```

### 時間の表現

- **数値**: 相対時間（ミリ秒）。現在時刻から遡る期間を表す
  - `1814400000` ms = 21日間
  - `43200000` ms = 12時間
- **配列**: 絶対時間。`[startEpochMs, endEpochMs]`
  - `~(timeRange~(~1771858800000~1771988400000))` → `[2026-02-24T00:00:00+09:00, 2026-02-25T12:00:00+09:00]`

### ハマったポイント

**閉じ括弧がない URL が存在する。**

```
#home:?~(timeRange~181440000     ← ) がない！
```

正規表現 `/\?(~\(.+\))$/` のように `)` を必須にすると壊れる。`indexOf("?~(")` で位置を特定し、残り全体を JSURL パーサーに渡す方式に変更。JSURL パーサー自体は `)` 未了でも文字列末尾でパースを終了できるため問題なし。

**`?` の前にパスがある場合がある。**

```
#home:?~(...)                            ← ?が : の直後
#home:dashboards/ApplicationELB?~(...)   ← ?の前にパスあり
```

`:?` の隣接を前提にした検出（`hash.includes(":?~(")`）だと後者が漏れる。`hash.includes("?~(")` に緩和。

---

## Pattern 2: CloudWatch Metrics — JSURL graph パラメータ

### 発見した URL

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #metricsV2:graph=~(start~'-PT3H~end~'now~...)
```

### 構造

```
#metricsV2:graph=<JSURL encoded graph object>
```

ハッシュ内の `graph=` パラメータが JSURL エンコードされたグラフ設定オブジェクト。`start` / `end` フィールドに時間範囲。

### 時間の表現

- **相対**: ISO 8601 duration 文字列 `"-PT3H"`（3時間前〜今）
- **絶対**: ISO 8601 タイムスタンプ文字列 or epoch ミリ秒

---

## Pattern 3: CloudWatch Logs Insights — 二重エンコード（Format A）

### 発見した URL

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #logsV2:log-groups/logs-insights?queryDetail=~$28end~0~start~-3600~timeType~$27RELATIVE$29
```

### 構造

```
#logsV2:...:logs-insights?queryDetail=<encoded value>
```

### エンコーディング（3段階）

`~` や数字はそのまま残り、`(` `)` `'` などの記号だけが `$XX` に変換される。

```
{ end: 0, start: -3600, timeType: "RELATIVE" }
  ↓ 1. JSURL encode
~(end~0~start~-3600~timeType~'RELATIVE)
  ↓ 2. encodeURIComponent （~や数字はそのまま、( ) ' だけ %XX に変換）
~%28end~0~start~-3600~timeType~%27RELATIVE%29
  ↓ 3. '%' → '$' 置換
~$28end~0~start~-3600~timeType~$27RELATIVE$29
```

デコードは逆順:

```
~$28end~0~start~-3600~timeType~$27RELATIVE$29
  ↓ 1. '$' → '%' に戻す
~%28end~0~start~-3600~timeType~%27RELATIVE%29
  ↓ 2. decodeURIComponent （%28→(  %27→'  %29→)）
~(end~0~start~-3600~timeType~'RELATIVE)
  ↓ 3. JSURL parse
{ end: 0, start: -3600, timeType: "RELATIVE" }
```

### 時間の表現

- `timeType: "RELATIVE"`: `start` は負の秒数（例: `-3600` = 1時間前）、`end` は `0`（今）
- `timeType: "ABSOLUTE"`: `start` / `end` は epoch 秒

---

## Pattern 4: CloudWatch Logs Insights — $エンコード区切り（Format B）

### 発見した URL

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #logsV2:logs-insights$3FqueryDetail$3D~(end~0~start~-43200~timeType~'RELATIVE~...)
```

### Format A との違い

同じ Logs Insights でも URL の構造が異なる2つのフォーマットが存在する。

| | Format A | Format B |
|---|---|---|
| `?` | リテラル `?` | `$3F` にエンコード |
| `=` | リテラル `=` | `$3D` にエンコード |
| JSURL値 | `$`エンコード（`%`→`$`） | **生の JSURL**（エンコードなし） |

Format B では `?` と `=` 自体が `$XX` でエンコードされているが、JSURL の値部分はエンコードされていない。

### ハマったポイント

**`queryDetail=` のリテラル検索ではヒットしない。**

```
queryDetail$3D~(end~0~start~-43200~...
             ^^^
             = が $3D になっている
```

`$3F` → `?`、`$3D` → `=` への正規化を先に行ってから `queryDetail=` をマッチさせる方式に変更。

**`end: 0` の falsy 問題。**

```js
if (obj.start && obj.end) {  // ← end が 0 だと false！
```

RELATIVE モードでは `end: 0`（= 現在時刻）が正常な値。`&&` による truthiness チェックを `!= null` に変更。

---

## Pattern 5: CloudWatch Log Events — プレーンパラメータ

### 発見した URL

```
https://<account>.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1
  #logsV2:log-groups/log-group/RDSOSMetrics/log-events/db-XXXXX$3Fstart$3D-1800000
```

### 構造

```
#logsV2:log-groups/log-group/<group>/log-events/<stream>$3Fstart$3D<ms>$26end$3D<ms>
```

`$3F` → `?`、`$3D` → `=`、`$26` → `&` で正規化すると:

```
?start=-1800000&end=...
```

JSURL は一切使わない、シンプルなクエリパラメータ形式。

### 時間の表現

- **負の値**: 相対ミリ秒（`-1800000` = 30分前から今まで）
- **正の大きな値**: 絶対 epoch ミリ秒

### Logs Insights との区別

同じ `logsV2:log-groups` で始まるが:
- `logs-insights` を含む → Logs Insights（Pattern 3/4）
- `log-events` + `$3Fstart$3D` を含む → Log Events（Pattern 5）

---

## Pattern 6: X-Ray — プレーンクエリパラメータ

### URL 例

```
https://<account>.console.aws.amazon.com/xray/home?region=ap-northeast-1
  &timeRange=PT1H
```

### 構造

最もシンプル。通常のクエリパラメータ `timeRange=` に直接値が入る。

### 時間の表現

- **相対**: ISO 8601 duration（`PT1H` = 直近1時間）
- **絶対**: `START~END` 形式（ISO 8601 タイムスタンプを `~` で区切り）

---

## 番外: URL に時間情報がないサービス

### 該当サービス

- ALB / ELB Monitoring (`/ec2/home#LoadBalancer:...;tab=monitoring`)
- RDS Performance Insights
- ECS / EKS モニタリング
- Lambda モニタリング

### URL 例

```
https://<account>.console.aws.amazon.com/ec2/home?region=ap-northeast-1
  #LoadBalancer:loadBalancerArn=arn:aws:...;tab=monitoring
```

時間範囲の情報が一切 URL に含まれず、AWS コンソール内部の UI 状態として管理されている。自動的な Capture / Apply は不可能。

### 対応方針

ポップアップに表示された時間範囲をクリックしてクリップボードにコピー → 手動で時間ピッカーにペースト。

---

## まとめ: なぜこんなにバラバラなのか

```
CloudWatch Metrics    → JSURL in hash
CloudWatch Home       → JSURL in hash (別形式)
Logs Insights (A)     → JSURL → URI encode → $ encode
Logs Insights (B)     → $ encode delimiters + raw JSURL
Log Events            → $ encode delimiters + plain params
X-Ray                 → plain query params
ALB Monitoring        → URL に情報なし
```

推測だが、AWSコンソールはサービスごとに異なるチームが異なる時期に開発しており、URL 設計の統一規約が存在しない（もしくは守られていない）。同じ CloudWatch 内ですら Logs Insights に2つのフォーマットが混在している。

Chrome 拡張でこれらを横断的に扱うには、各パターンを個別にパースするしかなく、新しいサービス画面に遭遇するたびに「URL を観察 → パターン特定 → パーサー追加」のサイクルを回す必要がある。
