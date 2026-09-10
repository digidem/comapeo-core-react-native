import { useEffect, useState } from 'react'
import { Button, ScrollView, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { crashBackendForTesting } from '@comapeo/core-react-native'

import { BackendStateIndicator } from './BackendStateIndicator'
import { DeviceIdIndicator } from './DeviceIdIndicator'
import { TestRunner } from './TestRunner'

/**
 * Visible for the first ~10s of every JS process, then hides. It reappears only
 * when a new JS process boots, so the fgs-restart-frontend flow can assert the
 * React Native frontend actually restarted (via ProcessPhoenix) rather than
 * merely the backend recovering.
 */
function FreshLaunchIndicator() {
	const [visible, setVisible] = useState(true)

	useEffect(() => {
		const t = setTimeout(() => setVisible(false), 10_000)
		return () => clearTimeout(t)
	}, [])

	if (!visible) return null
	return <Text testID="fresh-launch">fresh launch</Text>
}

export default function App() {
	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1 }}>
				<ScrollView style={{ backgroundColor: 'white' }}>
					<View style={{ padding: 20 }}>
						<Text style={{ fontWeight: 'bold', textAlign: 'center' }}>
							CoMapeo Core React Native E2E App
						</Text>
						<View style={{ alignItems: 'center', paddingTop: 8 }}>
							<FreshLaunchIndicator />
							<BackendStateIndicator />
							<DeviceIdIndicator />
						</View>
						<Button
							title="Crash backend (test)"
							testID="crash-backend"
							onPress={() => {
								crashBackendForTesting().catch(() => {})
							}}
						/>
					</View>

					<TestRunner />
				</ScrollView>
			</SafeAreaView>
		</SafeAreaProvider>
	)
}
