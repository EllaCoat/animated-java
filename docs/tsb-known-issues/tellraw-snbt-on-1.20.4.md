# TSB Known Issue: 1.20.4 ターゲットで text component が SNBT 形式で出力される

- **ステータス**: 解決済 (2026-05-22 夜、 案 a → **案 c に再差し替え**)
- **発見日**: 2026-05-21 (Phase B-1 生成検証 / 実機 export → Minecraft 1.20.4 確認)
- **再発見日**: 2026-05-22 夜 (案 a での修正後、 イーラ君手元 PC での再 export → 出力 datapack 内に `"color": red` が 7 ファイル残存)
- **解決日**: 2026-05-22 夜 (案 c 採用)
- **重大度**: 中 (`tellraw` を含む関数が 1.20.4 で構文エラーになる)
- **発生箇所**: `src/systems/datapackCompiler/tellraw.ts` + `book-and-quill` (stringifier.js)

## 症状

生成 datapack の `tellraw` 行 (例: `aj:axia/zzz/summon/animation_arg/if_empty`) の
text component が以下のように出力されていた :

```
tellraw @a [{"text":"","color":red},{"color":gray,"text":"\n "}, ...]
```

`red` / `gray` / `yellow` 等の named color **値** がダブルクォートで囲まれていない。
Minecraft 1.21.5+ の **SNBT 形式の text component** で、 1.20.4 では text component
は **JSON 必須** (`"color": "red"`)、 SNBT はパースエラーになる。

- 影響キー : `color`、 `action`、 `text` の値が identifier 形式 (`/^[a-zA-Z_][a-zA-Z0-9_\-.+]*$/`) のとき全て発生
- 件数 (axia blueprint, 2026-05-22 夜の検証時) : `tellraw` 行 7 件全てが該当

## 原因 (再分析、 2026-05-22 夜)

案 a (`tc.toString(true, target_version)` で明示的にバージョンを渡す) で
修正したが、 実機 export では SNBT のまま残った。 再調査で `book-and-quill`
側に **本質的なバグ**が見つかった :

- `stringifier.js` の `formatObject` は `REQUIRE_DOUBLE_QUOTES` flag を見て **キー側** を
  quote するかどうか決定する。 1.20.4 ターゲットでは flag が立つ。
- 一方 `stringifier.js` の **`stringifyString`** は `flag に関係なく` identifier 形式の
  値文字列を unquoted で返す :

  ```js
  // node_modules/book-and-quill/dist/stringifier.js
  if (/^[a-zA-Z_][a-zA-Z0-9_\-.+]*$/.test(str)) {
      return str;   // identifier 形式は常に unquoted
  }
  ```

- このため、 1.20.4 ターゲットでも **キーは quoted、 値は unquoted** という
  `{"color": red}` 形式が出力される (= 1.20.4 で構文エラー)。
- `defaultMinecraftVersion` を 1.20.4 に上書きしても、 `tc.toString(true, "1.20.4")`
  を明示的に呼んでも、 stringifier 内部の値処理は同じため救えない。

## 採用した修正 (案 c)

`book-and-quill` の stringifier を完全にバイパスし、 `JSON.stringify` で
シリアライズする。 `TextComponent.toJSON(true)` が `optimized()` 結果の
plain `TextElement[]` (Array / Object / String の組み合わせ) を返すため、
これを `JSON.stringify` に渡すだけで純粋 JSON 出力になる :

```ts
// src/systems/datapackCompiler/tellraw.ts
const renderTextComponent = (tc: TextComponent): string =>
    JSON.stringify(tc.toJSON(true))
```

ターゲットバージョンに依存しない (どのバージョンでも JSON は valid)。
`TextComponent` インスタンスをコンポーネントツリー内に nested で持っていても、
`JSON.stringify` は自動で各オブジェクトの `.toJSON()` を呼んでくれるため、 ネスト構造も
そのまま動く (`TELLRAW_PREFIX` / `CREATE_TELLRAW_HELP_LINK` の戻り値が `TextComponent`
インスタンスでも問題なし)。

## 案 a (廃案) との違い

| 観点 | 案 a (廃案) | 案 c (採用) |
|---|---|---|
| ターゲットバージョン依存 | 必要 (`target_minecraft_version` を渡す) | 不要 (常に JSON) |
| book-and-quill stringifier 経由 | yes | no |
| 値の SNBT 化問題 | **未解決** (stringifier の値処理が flag 非対応) | 解決 (バイパス) |
| 実装行数 | 案 a 関連は ~30 行 | 1 行 |

## upstream バグ報告

`book-and-quill` 1.0.9 の `stringifier.js` における `REQUIRE_DOUBLE_QUOTES` flag が
**キーのみに作用し、 値の `stringifyString` には作用しない**点は upstream のバグと
判定。 PR / Issue の余地あり (担当 : 未定、 必要なら別件で対応)。

- 影響範囲 : `book-and-quill` を使う全ライブラリで 1.20.4 (≦ 1.21.4) ターゲットの
  JSON 出力が壊れる
- 修正案 : `stringifyString` 冒頭に `if (this.enabledFeatures & FEATURES.REQUIRE_DOUBLE_QUOTES)
  return JSON.stringify(str)` を追加すれば値側も quoted JSON で出るようになる

## 検証

- `bun run prod` : 0 errors / 0 warnings
- `vitest run` : 30 ケース全通過 (`src/tests/tellraw.test.ts` に 8 ケース新規追加 :
  UNINSTALL / FRAME_CANNOT_BE_NEGATIVE / ARGUMENT_CANNOT_BE_EMPTY / INVALID_ANIMATION /
  INVALID_VARIANT / FUNCTION_NOT_EXECUTED_AS_ENTITY_WITH_ID_SCORE /
  AUTO_UPDATE_RIG_ORIENTATION_MOVE_WARNING / RIG_OUTDATED_TEXT_DISPLAY)
- リグレッションテスト : `assertPureJson` ヘルパーが `"color":(?!")[^,}\]]` /
  `"action":(?!")[^,}\]]` / `"text":(?!")[^,}\]"]` の 3 種類の unquoted パターンを
  全 TELLRAW.* 出力に対して拒否する
- 実機検証 : 次回 Blockbench export → 1.20.4 server reload で `"color":"red"` 形式に
  なっていることを確認 (イーラ君タスク)

## 同質バグの先回り修正 (text display 系、 2026-05-22 夜セッション)

`book-and-quill` の `stringifier` を経由する箇所は同じ unquoted 値バグの影響下に
あるため、 tellraw 修正と同時に **text display 系も JSON.stringify バイパスに統一**した :

- `src/systems/datapackCompiler/index.ts:157-159` (1.20.4-1.21.4 経路の summon NBT
  内 `text` フィールド) → `JSON.stringify(TextComponent.fromString(...).toJSON(true))`
- `src/panels/textDisplayElement/textDisplayElement.ts:328` (Blockbench UI の
  「Copy Text」ボタン、 clipboard 用) → 同上

`src/systems/datapackCompiler/index.ts:230` (1.21.5+ 専用パス、 placeholder
置換) は対象外。 1.21.5+ では tellraw / text display 共に SNBT が valid なので
そのままで動く。

axia blueprint は text display を使ってないため、 リグレッション検証は別 blueprint
(text display 含む) で必要。 イーラ君が「敢えて text_display 入れたモデル作って
みようかな」 と言ってたのが該当 (2026-05-22 夜セッション、 別タスク化)。

## 残課題 (別件)

- `book-and-quill` upstream PR / Issue (`stringifier.js` の `stringifyString` で
  `REQUIRE_DOUBLE_QUOTES` flag を尊重する修正) は別タスク。 ローカル fork や
  patch-package は使わず、 animated-java 側のバイパス修正で完結している。
