import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { Suspense } from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LoadingScreen } from '@/components/LoadingScreen';
import { ToastHost } from '@/components/ToastHost';
import { T } from '@/lib/theme';
import { ComapeoProviders } from '@/providers/ComapeoProviders';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: T.bg }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <ComapeoProviders>
          <ErrorBoundary>
            <Suspense fallback={<LoadingScreen label="Starting CoMapeo…" />}>
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: T.bg },
                  headerTitleStyle: { color: T.text, fontFamily: T.font },
                  headerTintColor: T.primary,
                  headerLargeTitle: Platform.OS === 'ios',
                  headerLargeTitleShadowVisible: false,
                  contentStyle: { backgroundColor: T.bg },
                }}
              />
            </Suspense>
          </ErrorBoundary>
        </ComapeoProviders>
        <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
          <ToastHost />
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
