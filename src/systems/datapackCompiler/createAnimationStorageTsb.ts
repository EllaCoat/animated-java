import type { IRenderedAnimation } from '../animationRenderer'
import type { IRenderedRig } from '../rigRenderer'

/**
 * TSB optimized animation storage compiler.
 *
 * Generates the TSB-specific datapack output:
 *  - B structure: animation -> bones|locators -> base36 ID -> frame
 *  - Pure number arrays (10 floats / 14 floats per cell, shear auto-detected)
 *  - Quantization with configurable digit count (default 5, range 3..5)
 *  - Macro-row staged loading (reload-time parse avoided)
 *  - Priority queue (immediate/high/low) + force load fallback
 *
 * Detailed spec: docs/next-tasks/animated-java-optimization.md (Phase B-1).
 * Currently a stub; full implementation is scheduled for Phase B-1.
 */
export async function createAnimationStorageTsb(
	rig: IRenderedRig,
	animations: IRenderedAnimation[],
): Promise<string[]> {
	void rig
	void animations
	throw new Error(
		'[TSB] createAnimationStorageTsb is not yet implemented (Phase B-1). ' +
			'Disable "TSB Optimized Export" in Blueprint Settings to use the standard compiler.',
	)
}
