import { ScrollView, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

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
					</View>

					<TestRunner />
				</ScrollView>
			</SafeAreaView>
		</SafeAreaProvider>
	)
}
