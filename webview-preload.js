'use strict';
// Runs inside the guest page (isolated world). Never touches page visuals.
const { ipcRenderer } = require('electron');
require('./scraper.js').install(ipcRenderer);
