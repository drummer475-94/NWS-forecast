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

    renderCurrentConditions(locationName, forecastData) {
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

        // Dewpoint (comes in Celsius usually, convert if temp is F)
        let dewpoint = '--';
        if (current.dewpoint && current.dewpoint.value !== null) {
            const dpC = current.dewpoint.value;
            dewpoint = current.temperatureUnit === 'F' ? this.celsiusToFahrenheit(dpC) : Math.round(dpC);
            dewpoint = `${dewpoint}°${current.temperatureUnit}`;
        }
        document.getElementById('current-dewpoint').textContent = dewpoint;

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
