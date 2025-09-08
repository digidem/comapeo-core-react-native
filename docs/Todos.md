### Implementation Todos

- [ ] Expose foreground service status and node process (CoMapeo Core) status to
      JS (`starting`, `running`, `stopping`, `stopped`) This isn't strictly
      necessary, because the IPC connection handles this in the background, but
      it could be nice for debugging and UI feedback.
- [ ] Serve blobs and icons over a unix domain socket, and wrap them in a
      content provider. This would prohibit access to the http server from other
      apps, and simplify sharing with other apps.
- [ ] Read abiFilters (gradle.build) from consuming app.
