// Initialize Lucide Icons
lucide.createIcons();

const App = {
    async init() {
        this.bindEvents();
        
        // Try to get user location on startup
        this.getUserLocation();
    },

    bindEvents() {
        const searchForm = document.getElementById('search-form');
        const geoBtn = document.getElementById('geo-btn');

        searchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const query = document.getElementById('search-input').value.trim();
            if (!query) return;

            UI.showError('');
            UI.showLoading(true);

            try {
                const { lat, lon, name } = await API.geocode(query);
                await this.loadWeatherData(lat, lon, name);
            } catch (err) {
                UI.showError(err.message);
                UI.showLoading(false);
            }
        });

        geoBtn.addEventListener('click', () => {
            this.getUserLocation();
        });
    },

    getUserLocation() {
        UI.showError('');
        UI.showLoading(true);

        if (!navigator.geolocation) {
            UI.showError('Geolocation is not supported by your browser');
            UI.showLoading(false);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                try {
                    const location = await API.reverseGeocode(lat, lon);
                    await this.loadWeatherData(lat, lon, location.name);
                } catch (err) {
                    UI.showError('Failed to get location name, but using coordinates.');
                    await this.loadWeatherData(lat, lon, 'Local Weather');
                }
            },
            (error) => {
                let msg = 'Location access denied.';
                if (error.code === 2) msg = 'Location unavailable.';
                if (error.code === 3) msg = 'Location request timed out.';
                UI.showError(msg);
                UI.showLoading(false);
                
                // Fallback to a default location (e.g., Washington DC) if user denies geo on initial load
                // Only do this if we haven't loaded anything yet
                if (document.getElementById('current-conditions').classList.contains('hidden')) {
                    this.loadWeatherData(38.9072, -77.0369, 'Washington, D.C.');
                }
            },
            { timeout: 10000 }
        );
    },

    async loadWeatherData(lat, lon, locationName) {
        UI.showLoading(true);
        UI.showError('');
        
        try {
            // 1. Get Grid Points from NWS
            const pointsData = await API.getNWSPoints(lat, lon);
            
            // 2. Fetch Forecast
            const forecastUrl = pointsData.properties.forecast;
            const hourlyUrl = pointsData.properties.forecastHourly;
            
            const [forecastData, hourlyData] = await Promise.all([
                API.getForecast(forecastUrl),
                API.getForecast(hourlyUrl).catch(() => null)
            ]);

            // 3. Update UI
            UI.renderCurrentConditions(locationName, forecastData, hourlyData);
            UI.renderForecast(forecastData);

            // 4. Update Map
            MapService.initMap(lat, lon);

        } catch (error) {
            UI.showError(error.message);
            console.error(error);
        } finally {
            UI.showLoading(false);
        }
    }
};

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
