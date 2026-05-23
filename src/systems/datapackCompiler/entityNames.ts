import { TextComponent } from 'book-and-quill'
import { makeTagSafe } from './tags'

// book-and-quill の TextComponentStringifier (.toString) は値側の identifier 形式文字列
// (`light_purple`, `gold`, `#00aced` 等) を REQUIRE_DOUBLE_QUOTES flag に関係なく unquoted で
// 返してしまうため、 CustomName が `{"text":aj.axia,"color":light_purple}` の壊れた JSON / SNBT
// 混在形式となりパースエラーになる。 stringifier 経由をやめ、 toJSON で取得した plain object を
// JSON.stringify でそのまま文字列化する。 これでターゲットバージョンに関係なく純粋 JSON が出る。
// 詳細 : docs/tsb-known-issues/tellraw-snbt-on-1.20.4.md (TELLRAW 側と同じ系統のバグ)
const renderTextComponent = (tc: TextComponent): string => JSON.stringify(tc.toJSON(true))

namespace ENTITY_NAMES {
	export const ROOT = (exportNamespace: string) =>
		renderTextComponent(
			new TextComponent([
				'',
				{ text: makeTagSafe(exportNamespace), color: '#00aced' },
				'.',
				{ text: 'root', color: 'light_purple' },
			]),
		)

	export const NODE = (exportNamespace: string, type: string, name: string) =>
		renderTextComponent(
			new TextComponent([
				'',
				{ text: makeTagSafe(exportNamespace), color: '#00aced' },
				'.',
				{ text: type, color: 'light_purple' },
				'.',
				{ text: name, color: 'gold' },
			]),
		)
}

export default ENTITY_NAMES
