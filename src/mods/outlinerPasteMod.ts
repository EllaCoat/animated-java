import { registerPatch } from 'blockbench-patch-manager'
import {
	activeProjectIsBlueprintFormat,
	BLUEPRINT_FORMAT,
	updateRotationConstraints,
} from '../formats/blueprint'
import { runWithRotationConstraintsSuspended } from '../formats/blueprint/rotationConstraintGuard'

registerPatch({
	id: `animated_java:preserve-pasted-cube-rotations`,

	apply: () => {
		const originalPasteOutliner = Clipbench.pasteOutliner

		Clipbench.pasteOutliner = function (event: Event) {
			if (!activeProjectIsBlueprintFormat()) return originalPasteOutliner(event)

			const format = BLUEPRINT_FORMAT.get()
			if (!format) return originalPasteOutliner(event)

			// Blockbench applies the format-wide Cube rotation limit during paste, which
			// discards every rotation axis except the first non-zero one. Keep the
			// source rotation intact; AJ still outlines and rejects invalid Cubes.
			runWithRotationConstraintsSuspended(
				format,
				() => originalPasteOutliner(event),
				updateRotationConstraints
			)
		}

		return { originalPasteOutliner }
	},

	revert: ({ originalPasteOutliner }) => {
		Clipbench.pasteOutliner = originalPasteOutliner
	},
})
