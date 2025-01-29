import { useEvent } from 'expo';
import ComapeoCore from '@comapeo/core-react-native';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';

export default function App() {
  const onChangePayload = useEvent(ComapeoCore, 'messageReceived');

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>Module API Example</Text>
        <Group name="Constants">
          <Text>{ComapeoCore.PI}</Text>
        </Group>
        <Group name="Message Server">
          <Button
            title="Send"
            onPress={async () => {
              for (let i = 0; i < 1000; i++) {
                ComapeoCore.sendMessage(`Hello ${i} from React Native!`.repeat(100));
              }
            }}
          />
        </Group>
        <Group name="Received Messages">
          <Text>{onChangePayload?.data}</Text>
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

const styles = {
  header: {
    fontSize: 30,
    margin: 20,
  },
  groupHeader: {
    fontSize: 20,
    marginBottom: 20,
  },
  group: {
    margin: 20,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
  },
  container: {
    flex: 1,
    backgroundColor: '#eee',
  },
  view: {
    flex: 1,
    height: 200,
  },
};
