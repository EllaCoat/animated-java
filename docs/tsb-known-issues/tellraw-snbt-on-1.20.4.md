# TSB Known Issue: 1.20.4 ターゲットで text component が SNBT 形式で出力される

- **ステータス**: 解決済（2026-05-22、案 a 採用）
- **発見日**: 2026-05-21（Phase B-1 生成検証 / 実機 export → Minecraft 1.20.4 確認）
- **解決日**: 2026-05-22（実機テストフィードバック後の即時修正）
- **重大度**: 中（`tellraw` を含む関数が 1.20.4 で構文エラーになっていた）
- **発生箇所**: `src/systems/datapackCompiler/tellraw.ts` + `book-and-quill` + `mc-build` 連携

## 症状

生成 datapack の `tellraw` 行（例: `aj:axia/zzz/summon/animation_arg/if_empty`）の
text component が以下のように出力されていた:

```
... "color": red ...
```

`red` がダブルクォートで囲まれていない。これは Minecraft 1.21.5+ の
**SNBT 形式の text component**。1.20.4 では text component は **JSON 必須**で、
`"color": "red"` でなければならず、SNBT はパースエラーになる。

## 原因

- `tellraw` 本文は `tellraw.ts` の `TELLRAW` 名前空間が `book-and-quill` の
  `TextComponent` で生成している。
- `book-and-quill` の `TextComponent.toString(minify, minecraftVersion)` は
  `minecraftVersion >= 1.21.5` で SNBT、未満で JSON を出力する
  （`node_modules/book-and-quill/dist/stringifier.js`）。
- `minecraftVersion` 省略時は静的プロパティ `TextComponent.defaultMinecraftVersion`
  （既定値 `1.21.11`）にフォールバックする。
- `src/systems/datapackCompiler/index.ts:548` で
  `TextComponent.defaultMinecraftVersion = version`（TSB export では `1.20.4`）を
  設定しているが、`mc-build` の `<%...%>` 式評価結果（`TextComponent` インスタンス）の
  文字列化にこの設定が反映されない。`mc-build` 側がどのタイミングで `.toString()` を
  どう呼ぶか上書きできないのが根本。

## 採用した修正（案 a）

`TELLRAW.*` を **文字列を返す関数** に変更し、 ターゲットバージョンを直接渡して
`toString` する。 `mc-build` の文字列化機構に依存しなくなる。

- `tellraw.ts` 冒頭にヘルパー `renderTextComponent(tc)` を追加 :
  `tc.toString(true, Project!.animated_java.target_minecraft_version)` で文字列化
- `TELLRAW_ERROR` / `TELLRAW_WARNING` が文字列を返すよう変更（`TextComponent` インスタンスは中で構築して `renderTextComponent` でラップ）
- `TELLRAW.UNINSTALL` / `TELLRAW.RIG_OUTDATED_TEXT_DISPLAY` も同様に `renderTextComponent` でラップ
- ヘルパー `TELLRAW_PREFIX` / `CREATE_TELLRAW_HELP_LINK` は依然 `TextComponent` インスタンスを返す（他の `TextComponent` の中にネスト埋め込み用のため）
- `index.ts:548` の `TextComponent.defaultMinecraftVersion = version` は維持（フォールバック保険）

影響範囲 : 1.20.4 / 1.21.x 全ターゲットで `tellraw.ts` を経由する出力が
ターゲットバージョン準拠で文字列化されるようになる。 純正 1.20.4 export にも
同一バグが存在していたため、 こちらも同時に解消される。

## 検証

- `bun run prod` : 0 errors / 0 warnings
- `vitest run` : 22 ケース全通過
- 実機検証 : 次回 Blockbench export → 1.20.4 server reload で `"color":"red"` 形式に
  なっていることを確認（イーラ君タスク）
