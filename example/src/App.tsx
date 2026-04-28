import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { TestRunner } from './TestRunner'

export default function App() {
	return (
		<SafeAreaView style={{ flex: 1 }}>
			<ScrollView style={{ backgroundColor: 'white' }}>
				<View style={{ padding: 20 }}>
					<Text style={{ fontWeight: 'bold', textAlign: 'center' }}>
						CoMapeo Core React Native App
					</Text>
				</View>

				<TestRunner />
			</ScrollView>
		</SafeAreaView>
	)
}
