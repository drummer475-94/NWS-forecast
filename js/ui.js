const UI = {
    // Determine Lucide icon based on short forecast string
    getWeatherIcon(shortForecast, isDaytime = true) {
        const text = shortForecast.toLowerCase();
        if (text.includes('thunderstorm') || text.includes('t-storm')) return 'cloud-lightning';
        if (text.includes('snow') || text.includes('blizzard')) return 'snowflake';
        if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return 'cloud-rain';
        if (text.includes('fog')) return 'cloud-fog';
        if (text.includes('cloudy') || text.includes('overcast')) {
            if (text.includes('partly')) return isDaytime ? 'cloud-sun' : 'cloud-moon';
            return 'cloud';
        }
        if (text.includes('wind')) return 'wind';
        return isDaytime ? 'sun' : 'moon';
    },

    // Convert Celsius to Fahrenheit
    celsiusToFahrenheit(c) {
        return Math.round((c * 9/5) + 32);
    },

    calculateFeelsLike(tempF, humidity, windSpeedStr) {
        let windMph = 0;
        if (windSpeedStr) {
            const match = windSpeedStr.match(/(\d+)/);
            if (match) windMph = parseInt(match[1], 10);
        }
        
        if (tempF <= 50 && windMph > 3) {
            return Math.round(35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16));
        }
        if (tempF >= 80 && humidity !== null && humidity !== undefined) {
            const t = tempF;
            const rh = humidity;
            const hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
            return Math.round(hi);
        }
        return tempF;
    },

    renderCurrentConditions(locationName, forecastData, hourlyData) {
        document.getElementById('location-name').textContent = locationName;
        
        const current = forecastData.properties.periods[0]; // Currently or rest of today
        const isDaytime = current.isDaytime;

        document.getElementById('current-temp').textContent = `${current.temperature}°${current.temperatureUnit}`;
        document.getElementById('current-desc').textContent = current.shortForecast;
        
        // Update Icon
        const iconName = this.getWeatherIcon(current.shortForecast, isDaytime);
        const iconElement = document.getElementById('current-icon');
        iconElement.setAttribute('data-lucide', iconName);
        
        // Details
        document.getElementById('current-wind').textContent = `${current.windSpeed} ${current.windDirection}`;
        
        // Probability of precipitation (can be null)
        const pop = current.probabilityOfPrecipitation?.value || 0;
        document.getElementById('current-precip').textContent = `${pop}%`;

        // Dewpoint, Humidity, Feels Like
        let dewpoint = '--';
        let humidity = '--';
        let feelsLike = `${current.temperature}°${current.temperatureUnit}`;
        
        if (hourlyData && hourlyData.properties && hourlyData.properties.periods && hourlyData.properties.periods.length > 0) {
            const hourlyCurrent = hourlyData.properties.periods[0];
            
            if (hourlyCurrent.relativeHumidity && hourlyCurrent.relativeHumidity.value !== null) {
                humidity = `${Math.round(hourlyCurrent.relativeHumidity.value)}%`;
                
                if (current.temperatureUnit === 'F') {
                    const fl = this.calculateFeelsLike(current.temperature, hourlyCurrent.relativeHumidity.value, current.windSpeed);
                    feelsLike = `${fl}°F`;
                }
            }
            
            if (hourlyCurrent.dewpoint && hourlyCurrent.dewpoint.value !== null) {
                const dpC = hourlyCurrent.dewpoint.value;
                const dpVal = current.temperatureUnit === 'F' ? this.celsiusToFahrenheit(dpC) : Math.round(dpC);
                dewpoint = `${dpVal}°${current.temperatureUnit}`;
            } else if (current.dewpoint && current.dewpoint.value !== null) {
                const dpC = current.dewpoint.value;
                const dpVal = current.temperatureUnit === 'F' ? this.celsiusToFahrenheit(dpC) : Math.round(dpC);
                dewpoint = `${dpVal}°${current.temperatureUnit}`;
            }
        } else if (current.dewpoint && current.dewpoint.value !== null) {
            const dpC = current.dewpoint.value;
            const dpVal = current.temperatureUnit === 'F' ? this.celsiusToFahrenheit(dpC) : Math.round(dpC);
            dewpoint = `${dpVal}°${current.temperatureUnit}`;
        }

        document.getElementById('current-dewpoint').textContent = dewpoint;
        
        const humidityEl = document.getElementById('current-humidity');
        if (humidityEl) humidityEl.textContent = humidity;
        
        const feelsLikeEl = document.getElementById('current-feels-like');
        if (feelsLikeEl) feelsLikeEl.textContent = feelsLike;

        // Re-initialize Lucide icons to apply the newly set data-lucide attribute
        lucide.createIcons();

        document.getElementById('current-conditions').classList.remove('hidden');
    },

    renderForecast(forecastData) {
        const container = document.getElementById('forecast-container');
        container.innerHTML = ''; // Clear previous

        const periods = forecastData.properties.periods;
        
        // Filter out only daytime periods for the 7-day overview, or night if it's currently night for the first one
        // To get a 7-day forecast, we group by name or pick daytime.
        const dailyForecasts = periods.filter(p => p.isDaytime || p.name.includes("Night") === false);
        
        // Ensure we only show about 7 items
        const itemsToShow = dailyForecasts.slice(0, 7);

        itemsToShow.forEach(period => {
            const iconName = this.getWeatherIcon(period.shortForecast, period.isDaytime);
            const pop = period.probabilityOfPrecipitation?.value || 0;

            const el = document.createElement('div');
            el.className = 'forecast-item';
            el.innerHTML = `
                <div class="forecast-day">${period.name}</div>
                <i data-lucide="${iconName}" class="forecast-icon"></i>
                <div class="forecast-temp">${period.temperature}°${period.temperatureUnit}</div>
                <div class="forecast-desc" title="${period.shortForecast}">${period.shortForecast}</div>
                <div class="forecast-precip">
                    <i data-lucide="droplets"></i> ${pop}%
                </div>
            `;
            container.appendChild(el);
        });

        lucide.createIcons();
        document.getElementById('forecast-section').classList.remove('hidden');
    },

    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (show) {
            overlay.classList.remove('hidden');
            document.getElementById('current-conditions').classList.add('hidden');
            document.getElementById('forecast-section').classList.add('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    },

    showError(msg) {
        const errEl = document.getElementById('search-error');
        if (msg) {
            errEl.textContent = msg;
            errEl.classList.remove('hidden');
        } else {
            errEl.classList.add('hidden');
            errEl.textContent = '';
        }
    }
};
