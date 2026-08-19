module.exports = async function(req, res) {
  // Bounding Box for Oklahoma: (33.5, -103.0, 37.0, -94.0)
  const query = `[out:json][timeout:30];node["man_made"="surveillance"]["surveillance:type"~"ALPR|automatic_number_plate_recognition"](33.5,-103.0,37.0,-94.0);out body;`;
  
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query)
    });
    
    if (!response.ok) {
      throw new Error("DeFlock API rejected the backend request.");
    }
    
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
