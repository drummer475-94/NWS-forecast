const API = {
    // 1. Geocoding using Nominatim (OpenStreetMap)
    // Note: Nominatim requires a user-agent or a clear contact in headers/query to avoid blocking.
    // For browser fetch, it's best to pass an 'email' param or just use standard params.
    async geocode(query) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
            if (!res.ok) throw new Error('Geocoding failed');
            const data = await res.json();
            if (data && data.length > 0) {
                return {
                    lat: parseFloat(data[0].lat),
                    lon: parseFloat(data[0].lon),
                    name: data[0].display_name.split(',')[0] // Get first part of name
                };
            }
            throw new Error('Location not found');
        } catch (error) {
            console.error('Geocode Error:', error);
            throw error;
        }
    },

    // 2. Reverse Geocoding (Lat/Lon to City Name)
    async reverseGeocode(lat, lon) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
            if (!res.ok) throw new Error('Reverse geocoding failed');
            const data = await res.json();
            
            // Extract the most sensible city/town/village name
            const address = data.address || {};
            const city = address.city || address.town || address.village || address.hamlet || address.county || 'Unknown Location';
            return {
                lat,
                lon,
                name: city
            };
        } catch (error) {
            console.error('Reverse Geocode Error:', error);
            // Fallback
            return { lat, lon, name: `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
        }
    },

    // 3. Get NWS Grid Points
    async getNWSPoints(lat, lon) {
        try {
            const res = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
            if (!res.ok) {
                if (res.status === 404) throw new Error('Location is outside the US or NWS coverage area.');
                throw new Error('Failed to fetch NWS point data');
            }
            return await res.json();
        } catch (error) {
            console.error('NWS Points Error:', error);
            throw error;
        }
    },

    // 4. Get NWS Forecast
    async getForecast(forecastUrl) {
        try {
            const res = await fetch(forecastUrl);
            if (!res.ok) throw new Error('Failed to fetch forecast data');
            return await res.json();
        } catch (error) {
            console.error('NWS Forecast Error:', error);
            throw error;
        }
    }
};
