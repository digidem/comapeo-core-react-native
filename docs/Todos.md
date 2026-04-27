### Implementation Todos

- [ ] Expose foreground service status and node process (CoMapeo Core) status to
      JS (`starting`, `running`, `stopping`, `stopped`) This isn't strictly
      necessary, because the IPC connection handles this in the background, but
      it could be nice for debugging and UI feedback.
- [ ] Serve blobs and icons over a unix domain socket, and wrap them in a
      content provider. This would prohibit access to the http server from other
      apps, and simplify sharing with other apps.
- [ ] Read abiFilters (gradle.build) from consuming app.

### Lifecycle Management

There are several lifecycles to manage:

1. The Android app lifecycle (foreground, background, killed)
2. The foreground service lifecycle (starting, running, stopping, stopped)
3. The NodeJS process lifecycle (starting, running, stopping, stopped)
4. The React Native lifecycle (starting, running, stopping, stopped)

Additionally, sockets and servers need to be managed, gracefully handling
disconnections and errors, and reconnecting as needed.

This isn't fully implemented yet, and needs more thought to ensure all edge
cases are handled.
