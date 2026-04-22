import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from './PrimaryButton';
import { T } from '@/lib/theme';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

// Minimal error boundary so a thrown query/error surfaces a useful message
// during development instead of the bundler's red box.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>{this.state.error.message}</Text>
        {this.state.error.stack ? (
          <Text style={styles.stack}>{this.state.error.stack}</Text>
        ) : null}
        <View style={{ height: 16 }} />
        <PrimaryButton onPress={this.reset}>Try again</PrimaryButton>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { padding: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '600', color: T.text },
  message: { fontSize: 15, color: '#991B1B', fontFamily: T.font },
  stack: { fontSize: 12, color: T.textMuted, fontFamily: T.mono, marginTop: 12 },
});
