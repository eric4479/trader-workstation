const axios = require("axios");
const { API_ENDPOINT, USERNAME, API_KEY } = require("./config");

async function getToken() {
  console.log(`Authenticating as: ${USERNAME}`);
  console.log(`Using API Key starting with: ${API_KEY.substring(0, 5)}...`);
  try {
    const res = await axios.post(
      `${API_ENDPOINT}/api/Auth/loginKey`,
      {
        userName: USERNAME,
        apiKey: API_KEY
      }
    );

    if (res.data && res.data.token) {
      return res.data.token;
    } else {
      console.error("Auth failed: Token not found in response", res.data);
      process.exit(1);
    }
  } catch (err) {
    console.error("Auth failed:", err.response?.data || err.message);
    process.exit(1);
  }
}

module.exports = { getToken };
