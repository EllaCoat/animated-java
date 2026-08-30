interface RotationLimitState {
	rotation_limit: boolean
}

let suspensionDepth = 0

export function rotationConstraintsAreSuspended() {
	return suspensionDepth > 0
}

export function runWithRotationConstraintsSuspended(
	state: RotationLimitState,
	action: () => void,
	restoreConstraints: () => void
) {
	const previousRotationLimit = state.rotation_limit
	suspensionDepth += 1
	state.rotation_limit = false

	try {
		action()
	} finally {
		state.rotation_limit = previousRotationLimit
		suspensionDepth -= 1
		if (suspensionDepth === 0) restoreConstraints()
	}
}
