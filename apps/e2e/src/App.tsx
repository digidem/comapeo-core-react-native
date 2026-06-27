import { ScrollView, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { BackendStateIndicator } from './BackendStateIndicator'
import { DeviceIdIndicator } from './DeviceIdIndicator'
import { TestRunner } from './TestRunner'

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
							<BackendStateIndicator />
							<DeviceIdIndicator />
						</View>
					</View>

					<TestRunner />
				</ScrollView>
			</SafeAreaView>
		</SafeAreaProvider>
	)
}
