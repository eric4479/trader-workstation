const axios = require('axios');
const { API_ENDPOINT, USERNAME, API_KEY, TOPSTEP_ENABLED } = require('./config');

function hasTopstepCredentials() {
  return TOPSTEP_ENABLED;
}

async function getToken(options = {}) {
  const { exitOnError = true } = options;

  if (!hasTopstepCredentials()) {
    const message = 'TopstepX credentials are not configured; live TopstepX stream disabled.';
    if (exitOnError) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }

  console.log(`Authenticating TopstepX as: ${USERNAME}`);
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
    }

    const message = `TopstepX auth failed: token not found in response ${JSON.stringify(res.data)}`;
    if (exitOnError) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    const message = `TopstepX auth failed: ${detail}`;
    if (exitOnError) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }
}

module.exports = { getToken, hasTopstepCredentials };
