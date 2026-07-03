/**
 * URL-composition contract of the media bridge: relative backend paths
 * (`/blobs/...`, `/icons/...`) become platform-native URLs, and the
 * shareable variant normalises either form before crossing into native.
 * The actual serving is covered by the backend, native, and e2e layers.
 */

function setup({ platform, authority = "com.example.app.comapeo.media" }) {
  const getShareableMediaUrl = jest.fn((path) =>
    Promise.resolve(`file:///cache/shared${path}`),
  );
  const getMediaContentAuthority = jest.fn(() =>
    platform === "android" ? authority : "",
  );

  jest.resetModules();
  jest.doMock("expo", () => ({
    requireNativeModule: () => ({
      getMediaContentAuthority,
      getShareableMediaUrl,
    }),
  }));
  jest.doMock("react-native", () => ({ Platform: { OS: platform } }));

  const mediaUrl = require("../mediaUrl");
  return { mediaUrl, getShareableMediaUrl, getMediaContentAuthority };
}

const BLOB_PATH = "/blobs/abc123/def456/photo/original/0011223344556677";

describe("getMediaBaseUrl / toMediaUrl", () => {
  it("composes a content:// URL from the app's provider authority on Android", () => {
    const { mediaUrl } = setup({ platform: "android" });
    expect(mediaUrl.getMediaBaseUrl()).toBe(
      "content://com.example.app.comapeo.media",
    );
    expect(mediaUrl.toMediaUrl(BLOB_PATH)).toBe(
      `content://com.example.app.comapeo.media${BLOB_PATH}`,
    );
  });

  it("composes a fixed comapeo://media URL on iOS", () => {
    const { mediaUrl } = setup({ platform: "ios" });
    expect(mediaUrl.getMediaBaseUrl()).toBe("comapeo://media");
    expect(mediaUrl.toMediaUrl(BLOB_PATH)).toBe(`comapeo://media${BLOB_PATH}`);
  });

  it("caches the Android authority instead of re-querying native", () => {
    const { mediaUrl, getMediaContentAuthority } = setup({
      platform: "android",
    });
    mediaUrl.toMediaUrl(BLOB_PATH);
    mediaUrl.toMediaUrl(BLOB_PATH);
    expect(getMediaContentAuthority).toHaveBeenCalledTimes(1);
  });

  it("rejects paths that are not relative", () => {
    const { mediaUrl } = setup({ platform: "ios" });
    expect(() => mediaUrl.toMediaUrl("blobs/nope")).toThrow(/beginning with/);
    expect(() => mediaUrl.toMediaUrl("http://127.0.0.1:123/blobs/x")).toThrow(
      /beginning with/,
    );
  });
});

describe("getShareableMediaUrl", () => {
  it("passes a relative path through to native", async () => {
    const { mediaUrl, getShareableMediaUrl } = setup({ platform: "ios" });
    await expect(mediaUrl.getShareableMediaUrl(BLOB_PATH)).resolves.toBe(
      `file:///cache/shared${BLOB_PATH}`,
    );
    expect(getShareableMediaUrl).toHaveBeenCalledWith(BLOB_PATH);
  });

  it("strips the in-app base URL before calling native", async () => {
    const { mediaUrl, getShareableMediaUrl } = setup({ platform: "android" });
    await mediaUrl.getShareableMediaUrl(
      `content://com.example.app.comapeo.media${BLOB_PATH}`,
    );
    expect(getShareableMediaUrl).toHaveBeenCalledWith(BLOB_PATH);
  });

  it("rejects URLs that are neither relative nor in-app media URLs", async () => {
    const { mediaUrl } = setup({ platform: "ios" });
    await expect(
      mediaUrl.getShareableMediaUrl("https://example.com/blobs/x"),
    ).rejects.toThrow(/relative media path/);
  });
});
