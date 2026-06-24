import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { state, type ComapeoState } from '@comapeo/core-react-native'

/**
 * Surfaces the backend lifecycle state with a per-state testID
 * (`backend-state-STARTED`, …) so a black-box flow can assert the FGS recovers
 * across a process teardown. See maestro/fgs-restart.yaml.
 */
export function BackendStateIndicator() {
	const [current, setCurrent] = useState<ComapeoState>(() => state.getState())

	useEffect(() => {
		const sub = state.addListener('stateChange', (next) => setCurrent(next))
		// Re-sync: the state may have changed between the initial render and here.
		setCurrent(state.getState())
		return () => sub.remove()
	}, [])

	return (
		<Text testID={`backend-state-${current}`}>{`backend: ${current}`}</Text>
	)
}
