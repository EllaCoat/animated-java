/**
 * tellraw レンダリング検証 : 1.20.4 ターゲットで TELLRAW.* が **純粋 JSON** を返すこと。
 *
 * book-and-quill の stringifier は値側の identifier 形式文字列を unquoted で出力するため
 * (`{"color": red}` が出る)、 1.20.4 では tellraw パースエラーになる。 これを回避するため
 * `renderTextComponent` を `JSON.stringify(tc.toJSON(true))` に置き換えている。
 *
 * 本テストは「unquoted color 値」 「unquoted action 値」 「unquoted text 値」 が
 * 一度も出力に含まれないことをガードする (リグレッションテスト)。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../util/minecraftUtil', () => ({
	toSmallCaps: (s: string) => s,
	parseResourceLocation(resourceLocation: string) {
		let [namespace, ...parts] = resourceLocation.split(':')
		if (parts.length === 0) {
			parts = [namespace]
			namespace = 'minecraft'
		}
		return { namespace, path: parts.join('') }
	},
}))

// 念のため type-only import 経路を完全に遮断 (verbatimModuleSyntax で消えるはずだが、
// 万一 transitive で読まれても Blockbench global を要求するため空モジュール化)。
vi.mock('../systems/animationRenderer', () => ({}))
vi.mock('../systems/rigRenderer', () => ({}))

// tellraw.ts は v1.10.2 取り込みで `projectTargetVersionIsAtLeast` を使うようになったが、
// formats/blueprint は svelte component / svg asset / blockbench-patch-manager を芋づるで
// 引くため vitest では解決できない (= `window is not defined` で collect 段階から落ちる)。
// 実際に使うのはこの 1 関数だけなので、 忠実な最小コピーで差し替える。
vi.mock('../formats/blueprint', () => ({
	projectTargetVersionIsAtLeast(version: string): boolean {
		if (!Project?.animated_java) return false
		return !compareVersions(version, Project.animated_java.target_minecraft_version)
	},
}))

// `generic-stream` の broken ESM resolution は vitest.config.ts の resolve.alias 経由で
// `src/tests/stubs/genericStream.ts` に差し替え済。 ここでは追加 mock 不要。

beforeAll(() => {
	vi.stubGlobal('Project', {
		animated_java: {
			blueprint_id: 'aj:test',
			target_minecraft_version: '1.20.4',
		},
	})
	// AJ codebase が依存する Blockbench grobal `compareVersions(a, b)`:
	//   returns truthy when a > b (or non-zero), falsy when equal.
	// We mimic that with a simple semver-aware impl, sufficient for the 1.21.5 branch checks
	// in tellraw.ts.
	vi.stubGlobal('compareVersions', (a: string, b: string) => {
		const aParts = a.split('.').map(Number)
		const bParts = b.split('.').map(Number)
		for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
			const ap = aParts[i] ?? 0
			const bp = bParts[i] ?? 0
			if (ap !== bp) return ap > bp ? 1 : -1
		}
		return 0
	})
})

import TELLRAW from '../systems/datapackCompiler/tellraw'

const UNQUOTED_VALUE_PATTERNS = [
	/"color":(?!")[^,}\]]/,
	/"action":(?!")[^,}\]]/,
	/"text":(?!")[^,}\]"]/, // text の値が unquoted な identifier
]

function assertPureJson(out: string) {
	for (const re of UNQUOTED_VALUE_PATTERNS) {
		expect(out, `SNBT-style unquoted value remained: ${out}`).not.toMatch(re)
	}
	expect(() => JSON.parse(out)).not.toThrow()
}

describe('TELLRAW renders pure JSON on 1.20.4', () => {
	it('UNINSTALL has quoted color/text values', () => {
		const out = TELLRAW.UNINSTALL()
		expect(out).toContain('"color":"green"')
		expect(out).toContain('"color":"yellow"')
		assertPureJson(out)
	})

	it('FRAME_CANNOT_BE_NEGATIVE has quoted color:red', () => {
		const out = TELLRAW.FRAME_CANNOT_BE_NEGATIVE()
		expect(out).toContain('"color":"red"')
		expect(out).toContain('"color":"yellow"')
		assertPureJson(out)
	})

	it('ARGUMENT_CANNOT_BE_EMPTY (name=animation) has quoted color', () => {
		const out = TELLRAW.ARGUMENT_CANNOT_BE_EMPTY('animation')
		expect(out).toContain('"color":"red"')
		expect(out).toContain('"color":"yellow"')
		// text の値 "animation" も quoted で出るべき
		expect(out).toContain('"text":"animation"')
		assertPureJson(out)
	})

	it('INVALID_ANIMATION (animations list) has all quoted values', () => {
		const out = TELLRAW.INVALID_ANIMATION([
			{ storage_name: 'idle' } as any,
			{ storage_name: 'walk' } as any,
		])
		expect(out).toContain('"text":"idle"')
		expect(out).toContain('"text":"walk"')
		expect(out).toContain('"color":"yellow"')
		expect(out).toContain('"color":"green"')
		assertPureJson(out)
	})

	it('INVALID_VARIANT (variants dict) has all quoted values', () => {
		const out = TELLRAW.INVALID_VARIANT({
			default: { name: 'default' } as any,
			alt: { name: 'alt' } as any,
		})
		expect(out).toContain('"text":"default"')
		expect(out).toContain('"text":"alt"')
		expect(out).toContain('"color":"yellow"')
		assertPureJson(out)
	})

	it('FUNCTION_NOT_EXECUTED_AS_ENTITY_WITH_ID_SCORE quoted color:yellow + score id', () => {
		const out = TELLRAW.FUNCTION_NOT_EXECUTED_AS_ENTITY_WITH_ID_SCORE('aj:test/as_root')
		expect(out).toContain('"color":"yellow"')
		// score 名 "aj.id" は identifier 風だが quoted されるべき
		expect(out).toContain('"text":"aj.id"')
		assertPureJson(out)
	})

	it('AUTO_UPDATE_RIG_ORIENTATION_MOVE_WARNING quoted move keyword', () => {
		const out = TELLRAW.AUTO_UPDATE_RIG_ORIENTATION_MOVE_WARNING()
		expect(out).toContain('"text":"move"')
		expect(out).toContain('"color":"yellow"')
		assertPureJson(out)
	})

	it('RIG_OUTDATED_TEXT_DISPLAY: \\n is double-escaped (\\\\n) for summon NBT embedding', () => {
		const out = TELLRAW.RIG_OUTDATED_TEXT_DISPLAY()
		// 中身は JSON だが、 newline は 4 バックスラッシュにエスケープされてる
		expect(out).toContain('\\\\n')
		expect(out).toContain('"color":"red"')
	})
})
