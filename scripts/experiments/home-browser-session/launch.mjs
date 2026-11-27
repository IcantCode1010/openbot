// Isolated personal experiment. No browser data, debugger, or network API.
export const DEMO_URL = "https://www.amazon.com/";

export async function openHomeBrowser({ defaultHttpsHandler, openExternal }) {
  if ((await defaultHttpsHandler()).trim() !== "ChromeHTML") {
    throw new Error("Chrome is not the Windows HTTPS default. No browser was opened.");
  }
  await openExternal(DEMO_URL);
}

