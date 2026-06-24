import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { comapeo } from '@comapeo/core-react-native'

/**
 * Surfaces the backend deviceId (derived from the persisted rootkey) in a
 * stable, black-box-readable element so a flow can capture it before a process
 * teardown and assert it is unchanged after a cold relaunch. See
 * maestro/rootkey-persistence.yaml.
 *
 * `deviceId()` resolves only once the backend is up, so the element appears
 * after backend-state-STARTED. The full id is rendered (not truncated) so
 * Maestro's copyTextFrom captures a value that can be compared exactly.
 */
export function DeviceIdIndicator() {
	const [deviceId, setDeviceId] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		comapeo
			.deviceId()
			.then((id) => {
				if (!cancelled) setDeviceId(id)
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	if (!deviceId) return null

	return <Text testID="device-id">{`deviceId: ${deviceId}`}</Text>
}
