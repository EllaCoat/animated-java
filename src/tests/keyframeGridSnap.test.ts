/**
 * 「1 tick 前の keyframe」 引きの格子スナップ単体テスト。 純粋な算術なので Blockbench global 不要。
 *
 * keyframeCache のキーは load 時に `roundToNth(kf.time, 20)` で格子へ正規化される
 * (= `src/mods/animation.ts` の extend override 内の正規化ループ) 一方、 frame ループの `time` も
 * 毎ステップ `roundToNth(time + 0.05, 20)` で再スナップされる
 * (= `src/systems/animationRenderer.ts` の `renderAnimation` の frame ループ)。
 * ところが引く側の `time - 0.05` だけは正規化を通っておらず、 減算結果が格子から外れて
 * `Map.get` がヒットしない frame が出る (= pre-post interpolation の指定が出力から落ちる)。
 *
 * あわせて、 正規化ループ自身の衝突回避 (= 丸め先が直前の keyframe と重なったら 1 tick ずらす)
 * も格子を外れうるので、 そちらも同じ観点で固定する。
 *
 * 確認するのは :
 * 1. frame ループが 0〜3 秒で 61 frame を生成すること
 * 2. 修正前の式 `time - 0.05` では 20 frame で keyframe を引けないこと (= バグの規模)
 * 3. 修正後の式 `roundToNth(time - 0.05, 20)` では取りこぼしが 0 件になること
 * 4. 衝突回避でずらした時刻が格子上に載り、 自 frame と 1 tick 後の frame の両方から引けること
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
 * keyframe 側のキー集合を `src/mods/animation.ts` の正規化式 (`roundToNth(kf.time,
 * DEFAULT_SNAPPING_VALUE)`) と同じ形で作る。
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
 * `src/systems/animationRenderer.ts` の `renderAnimation` の frame ループと同じ式で回し、
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

// --- 衝突回避 (= mods/animation.ts の load 時正規化) ---------------------------

/**
 * `src/mods/animation.ts` の load 時正規化ループを写したもの (= 本体は Blockbench 結合が
 * 重く vitest から import できないため、 式だけを 1:1 で再現する)。
 *
 * production と同じく「格子に載っていた keyframe は素通しし、 `lastTime` も更新しない」
 * 挙動まで含めて写している。
 *
 * @param deconflict 丸め先が直前の keyframe と重なったときのずらし方
 */
function normalizeKeyframeTimes(
	times: readonly number[],
	deconflict: (rounded: number) => number
): number[] {
	const result: number[] = []
	let lastTime = -Infinity
	for (const time of times) {
		let rounded = roundToNth(time, SNAPPING)
		if (rounded === time) {
			result.push(time)
			continue
		}
		if (rounded === lastTime) rounded = deconflict(rounded)
		result.push(rounded)
		lastTime = rounded
	}
	return result
}

/** 修正前のずらし方 (= 素の加算)。 */
const RAW_DECONFLICT = (rounded: number) => rounded + TICK
/** 修正後のずらし方 (= ずらした結果も格子へ載せ直す)。 */
const SNAPPED_DECONFLICT = (rounded: number) => roundToNth(rounded + TICK, SNAPPING)

/**
 * 衝突する 2 つの keyframe。 どちらも `roundToNth(t, 20)` が 0.1 に落ちるため、
 * 2 つ目が衝突回避で 1 tick ずらされる。
 */
const COLLIDING_TIMES = [0.11, 0.12] as const

describe('mods/animation.ts の衝突回避 - 格子スナップ', () => {
	it('修正前のずらし方は格子から外れた時刻を作る', () => {
		const [first, second] = normalizeKeyframeTimes(COLLIDING_TIMES, RAW_DECONFLICT)
		expect(first).toBe(0.1)
		expect(second).toBe(0.15000000000000002)
		expect(second).not.toBe(0.15)
		expect(buildKeyframeKeys().has(second)).toBe(false)
	})

	it('修正後のずらし方は格子上の時刻を作る', () => {
		const [first, second] = normalizeKeyframeTimes(COLLIDING_TIMES, SNAPPED_DECONFLICT)
		expect(first).toBe(0.1)
		expect(second).toBe(0.15)
		expect(buildKeyframeKeys().has(second)).toBe(true)
	})

	it('衝突回避で作られた keyframe を自 frame と 1 tick 後の frame の両方から引ける', () => {
		const normalized = normalizeKeyframeTimes(COLLIDING_TIMES, SNAPPED_DECONFLICT)
		// getFrame の keyframeCache と同じく `kf.time` をそのままキーにする。
		const keyframes = new Map(normalized.map((time, index) => [time, index]))

		// 自 frame (= `keyframes.get(time)`) から引ける。
		expect(keyframes.get(0.15)).toBe(1)
		// 1 tick 後の frame (= `keyframes.get(roundToNth(time - 0.05, 20))`) からも引ける。
		expect(keyframes.get(roundToNth(0.2 - TICK, SNAPPING))).toBe(1)
	})

	it('修正前は自 frame から引けず 1 tick 後からだけ引けるという不整合だった', () => {
		const normalized = normalizeKeyframeTimes(COLLIDING_TIMES, RAW_DECONFLICT)
		const keyframes = new Map(normalized.map((time, index) => [time, index]))

		// frame 0.15 は自分の keyframe を認識できない。
		expect(keyframes.get(0.15)).toBeUndefined()
		// 一方で `0.2 - 0.05` は 0.15000000000000002 と同じ double なので偶然ヒットしていた。
		expect(0.2 - TICK).toBe(0.15000000000000002)
		expect(keyframes.get(0.2 - TICK)).toBe(1)
		// 再スナップを入れるとその偶然のヒットも消える (= 修正前の式との組み合わせでは全滅)。
		expect(keyframes.get(roundToNth(0.2 - TICK, SNAPPING))).toBeUndefined()
	})

	it('連鎖衝突は修正後のみ検出される', () => {
		// 3 つとも 0.1 / 0.15 へ丸まる並び。
		const chain = [0.11, 0.12, 0.13] as const
		// 修正前は 2 つ目が 0.15000000000000002 になるため、 3 つ目の 0.15 と衝突判定されず、
		// 実質同時刻の keyframe が 2 つ残っていた。
		expect(normalizeKeyframeTimes(chain, RAW_DECONFLICT)).toEqual([
			0.1, 0.15000000000000002, 0.15,
		])
		// 修正後は衝突が正しく検出され、 次の格子へ送られる。
		expect(normalizeKeyframeTimes(chain, SNAPPED_DECONFLICT)).toEqual([0.1, 0.15, 0.2])
	})
})
