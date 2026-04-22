# dev-example

A multi-screen Expo example app for the CoMapeo Core React Native module. Sits
alongside the existing `example/` smoke-test and serves as the canonical
reference for building apps on top of `@comapeo/core-react-native` +
`@comapeo/core-react`.

## What's inside

- **Expo Router** (file-based stack navigation) under `src/app/`
- **`@comapeo/core-react`** hooks for every read/write API the module exposes
- **Platform-aware primitives** under `src/components/` (one component tree per
  screen; only header chrome / dividers / typography swap between iOS and
  Android via `Platform.select`)
- **Local module resolution** — Metro's `resolveRequest` points
  `@comapeo/core-react-native` at `../src/index.ts` so changes to the parent
  module's TypeScript are picked up live (no need to run `npm run build`)

## Screens

| Route                                                       | Hook(s)                                              |
|-------------------------------------------------------------|------------------------------------------------------|
| `/` ProjectsHome                                            | `useManyProjects`, `useOwnDeviceInfo`, `useManyInvites` |
| `/new-project` (modal)                                      | `useCreateProject`                                   |
| `/device`                                                   | `useOwnDeviceInfo`, `useSetOwnDeviceInfo`, `useIsArchiveDevice`, `useSetIsArchiveDevice` |
| `/invites`                                                  | `useManyInvites`, `useAcceptInvite`, `useRejectInvite` |
| `/projects/[projectId]` ProjectHome                         | `useProjectSettings`, `useManyDocs` (counts), `useSyncState` |
| `/projects/[projectId]/settings`                            | `useProjectSettings`, `useUpdateProjectSettings`     |
| `/projects/[projectId]/leave` (modal)                       | `useLeaveProject`                                    |
| `/projects/[projectId]/observations` + `[docId]` + `new`    | `useManyDocs`, `useSingleDocByDocId`, `useCreateDocument`, `useUpdateDocument`, `useDeleteDocument`, `usePresetsSelection` |
| `/projects/[projectId]/tracks` + `[docId]`                  | `useManyDocs`, `useSingleDocByDocId`                 |
| `/projects/[projectId]/presets` + `[docId]`                 | `useManyDocs`, `useSingleDocByDocId`                 |
| `/projects/[projectId]/fields` + `[docId]`                  | `useManyDocs`, `useSingleDocByDocId`                 |
| `/projects/[projectId]/members`                             | `useManyMembers`                                     |
| `/projects/[projectId]/invites`                             | `useSendInvite`                                      |
| `/projects/[projectId]/sync`                                | `useSyncState`, `useDataSyncProgress`, `useStartSync`, `useStopSync` |
| `/projects/[projectId]/map-shares`                          | `useManyReceivedMapShares` (placeholder; map server not wired)  |

## Running

From the **module root** (one level up):

```sh
cd dev-example
npm install        # if node_modules is missing
npx expo prebuild  # generate native folders (first time only)
npm run android    # or `npm run ios`
```

The first build will take a while because the parent module's nodejs-mobile
backend has to be downloaded and bundled.

## Map server

`getMapServerBaseUrl` is currently stubbed in
`src/providers/ComapeoProviders.tsx` because the native module does not yet
bundle a CoMapeo map server. This means the following hooks won't work:

- `useMapStyleUrl`
- `useIconUrl`
- `useAttachmentUrl`
- `useManyReceivedMapShares` (and friends)

Everything else — projects, observations, tracks, presets, fields, members,
invites, sync, device info — works.

## Adding a new screen

1. Drop a new file under `src/app/` (e.g. `src/app/projects/[projectId]/my-thing.tsx`).
2. Use `useProjectId()` to read the dynamic segment if you're inside `[projectId]/`.
3. Compose `Screen`, `Section`, `Row`, `FormField`, `PrimaryButton` to build
   the layout. Avoid `Platform.OS` branches at the screen level — push them
   into the primitives in `src/components/` if you find you need them.
4. Wire the relevant hook from `@comapeo/core-react`.

## Why two example apps?

`example/` is the minimal smoke test used by the e2e tests. `dev-example/`
demonstrates real app patterns (navigation, providers, forms) and gives a
human a place to click around the API.
