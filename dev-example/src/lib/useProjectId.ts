import { useLocalSearchParams } from 'expo-router';

// Read the [projectId] dynamic route segment for any screen nested inside
// app/projects/[projectId]/. Throws clearly if used outside that subtree.
export function useProjectId(): string {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  if (!projectId) {
    throw new Error('useProjectId() called outside of a [projectId] route');
  }
  return projectId;
}
