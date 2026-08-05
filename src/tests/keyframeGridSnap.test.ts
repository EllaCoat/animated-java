/**
 * 「1 tick 前の keyframe」 引きの格子スナップ単体テスト。 純粋な算術なので Blockbench global 不要。
 *
 * keyframeCache のキーは load 時に `roundToNth(kf.time, 20)` で格子へ正規化される
 * (`src/mods/animation.ts:70`) 一方、 frame ループの `time` も毎ステップ
 * `roundToNth(time + 0.05, 20)` で再スナップされる (`src/systems/animationRenderer.ts:331`)。
 * ところが引く側の `time - 0.05` だけは正規化を通っておらず、 減算結果が格子から外れて
 * `Map.get` がヒットしない frame が出る (= pre-post interpolation の指定が出力から落ちる)。
 *
 * 確認するのは :
 * 1. frame ループが 0〜3 秒で 61 frame を生成すること
 * 2. 修正前の式 `time - 0.05` では 20 frame で keyframe を引けないこと (= バグの規模)
 * 3. 修正後の式 `roundToNth(time - 0.05, 20)` では取りこぼしが 0 件になること
 */
import { describe, expect, it } from 'vitest'
import { roundToNth } from '../util/misc'

/** frame ループ 1 ステップの刻み幅 (= 1 tick)。 */
const TICK = 0.05
/** keyframe の格子分解能 (= `DEFAULT_SNAPPING_VALUE`)。 */
const SNAPPING = 20
/** テスト対象の animation 長 (秒)。 */
const LENGTH = 3

/**
 * keyframe 側のキー集合を `src/mods/animation.ts:70` と同じ式で作る。
 * 0〜3 秒の全 tick 位置に keyframe が置かれている状況を想定する。
 */
function buildKeyframeKeys(): Set<number> {
	const keys = new Set<number>()
	for (let k = 0; k <= LENGTH * SNAPPING; k++) {
		keys.add(roundToNth(k / SNAPPING, SNAPPING))
	}
	return keys
}

/**
 * `src/systems/animationRenderer.ts:331` と同じ式で frame ループを回し、
 * 各 frame の `time` を列挙する。
 */
function collectFrameTimes(): number[] {
	const times: number[] = []
	for (let time = 0; time <= LENGTH; time = roundToNth(time + TICK, SNAPPING)) {
		times.push(time)
	}
	return times
}

/**
 * 「1 tick 前」 を `lookup` で引いたときの取りこぼし件数を数える。
 * `time = 0` は前 frame 自体が存在しないので対象から除く。
 */
function countMisses(keys: Set<number>, lookup: (time: number) => number): number {
	let misses = 0
	for (const time of collectFrameTimes()) {
		if (time < TICK) continue
		if (!keys.has(lookup(time))) misses++
	}
	return misses
}

describe('getFrame の 1 tick 前 keyframe 引き - 格子スナップ', () => {
	it('frame ループは 0〜3 秒で 61 frame を生成する', () => {
		expect(collectFrameTimes()).toHaveLength(61)
	})

	it('修正前の式 (time - 0.05) は 20 frame で keyframe を引けない', () => {
		const keys = buildKeyframeKeys()
		expect(countMisses(keys, time => time - TICK)).toBe(20)
	})

	it('修正後の式 (roundToNth(time - 0.05, 20)) は取りこぼしが 0 件', () => {
		const keys = buildKeyframeKeys()
		expect(countMisses(keys, time => roundToNth(time - TICK, SNAPPING))).toBe(0)
	})

	it('格子から外れる代表例 (t=0.15 / t=0.2) を再スナップで救えている', () => {
		const keys = buildKeyframeKeys()
		// 減算そのままだと 0.09999999999999999 / 0.15000000000000002 になり格子と一致しない
		expect(keys.has(0.15 - TICK)).toBe(false)
		expect(keys.has(0.2 - TICK)).toBe(false)
		expect(roundToNth(0.15 - TICK, SNAPPING)).toBe(0.1)
		expect(roundToNth(0.2 - TICK, SNAPPING)).toBe(0.15)
	})
})
