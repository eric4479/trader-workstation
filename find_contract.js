const axios = require("axios");
const { getToken } = require("./auth");
const { API_ENDPOINT } = require("./config");

async function findContract() {
  const token = await getToken();
  try {
    const res = await axios.post(`${API_ENDPOINT}/api/Contract/search`, 
      { searchText: "MNQ", live: false },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log("Contracts found:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Search failed:", err.response?.data || err.message);
  }
}

findContract();
