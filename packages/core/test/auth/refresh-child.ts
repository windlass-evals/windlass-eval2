/** One process of the refresh test: asks for an access token (good for at least the given milliseconds, when given) and prints it. */
import { accessToken, type AuthConfig, savedAccessToken } from "../../src/auth/chatgpt.ts"

const [tokenUrl, dir, validForMs] = process.argv.slice(2)
const config: AuthConfig = { issuer: "test", authorizeUrl: "", tokenUrl: tokenUrl!, jwksUrl: "", dataDir: () => dir! }
console.log(validForMs === undefined ? await accessToken(config) : (await savedAccessToken(config, Number(validForMs))).accessToken)
