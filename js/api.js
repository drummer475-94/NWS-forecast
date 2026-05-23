const API = {
    // 1. Geocoding using Nominatim (OpenStreetMap)
    async geocode(query) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
            if (!res.ok) throw new Error('Geocoding failed');
            const data = await res.json();
            if (data && data.length > 0) {
                return {
                    lat: parseFloat(data[0].lat),
                    lon: parseFloat(data[0].lon),
                    name: data[0].display_name.split(',')[0]
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
            
            const address = data.address || {};
            const city = address.city || address.town || address.village || address.hamlet || address.county || 'Unknown Location';
            return {
                lat,
                lon,
                name: city
            };
        } catch (error) {
            console.error('Reverse Geocode Error:', error);
            return { lat, lon, name: `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
        }
    },

    // 3. Search Autocomplete suggestions (Nominatim)
    async getSuggestions(query) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=5`);
            if (!res.ok) throw new Error('Autocomplete failed');
            const data = await res.json();
            if (data && data.length > 0) {
                return data.map(item => {
                    const address = item.address || {};
                    const city = address.city || address.town || address.village || address.hamlet || address.municipality || item.display_name.split(',')[0];
                    const state = address.state || address.region || '';
                    const country = address.country || '';
                    
                    let label = city;
                    if (state) label += `, ${state}`;
                    else if (country) label += `, ${country}`;
                    
                    return {
                        lat: parseFloat(item.lat),
                        lon: parseFloat(item.lon),
                        label: label,
                        displayName: item.display_name
                    };
                });
            }
            return [];
        } catch (error) {
            console.error('Autocomplete Error:', error);
            return [];
        }
    },

    // 4. Get NWS Grid Points
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

    // 5. Get NWS Forecast
    async getForecast(forecastUrl) {
        try {
            const res = await fetch(forecastUrl);
            if (!res.ok) throw new Error('Failed to fetch forecast data');
            return await res.json();
        } catch (error) {
            console.error('NWS Forecast Error:', error);
            throw error;
        }
    },

    // 6. Get NWS Alerts
    async getAlerts(lat, lon) {
        try {
            const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
            if (!res.ok) throw new Error('Failed to fetch alerts');
            return await res.json();
        } catch (error) {
            console.error('NWS Alerts Error:', error);
            return null; // non-critical failure
        }
    }
};
