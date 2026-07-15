# SexPornHD — Replicated Premium Catalog Directory & Scraper Portal

A lightweight, high-performance web portal that replicates a premium video directory by scraping and caching content dynamically. 

This repository contains both the Node.js scraper-proxy server backend and a modern responsive frontend with ad-ready slots and an embedded video player.

---

## 🚀 Key Features

* **Real-time Scraper Backend:** Dynamically fetches and parses catalog listings, categories, search results, and model directories on the fly from the source catalog.
* **MessagePack Payload Decoding:** Decodes base64/MessagePack-obfuscated redirection payloads to extract direct target video links.
* **TTL Memory Caching:** Prevents rate-limiting and boosts performance with intelligent caching (15-minute TTL for video grids, 60-minute TTL for category metadata).
* **Premium UI/UX:** Responsive, modern design styled with a dark theme, Outfit typography, custom tag pills, search autocomplete, and smooth micro-animations.
* **Adult Ad Ready:** Pre-designed, responsive placeholder positions matching standard ad sizes (728x90 banners, 160x600 skyscrapers, 300x250/300x600 rectangle grids).
* **Zero External Dependencies:** Built entirely with Node.js built-in modules (`http`, `https`, `fs`, `path`). No `npm install` required!

---

## 🛠️ Technology Stack

* **Frontend:**
  - Vanilla HTML5 / ES6 JavaScript
  - Vanilla CSS3 (Custom responsive layout & CSS variables)
  - [Outfit (Google Fonts)](https://fonts.google.com/specimen/Outfit) for typography
  - [FontAwesome](https://fontawesome.com/) for micro-icons

* **Backend:**
  - Node.js (HTTP / HTTPS standard library)
  - Custom base64url and MessagePack payload decoder

---

## ⚙️ Installation & Running Locally

Since the application uses standard Node.js libraries, you do not need to install any external dependencies.

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed (v16.0.0 or higher is recommended).

### Steps
1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/super-sg/SondhyaSoft.git
   cd SondhyaSoft
   ```

2. Start the Node.js server:
   ```bash
   node server.js
   ```

3. Open your web browser and navigate to:
   ```
   http://localhost:8080
   ```

---

## 📂 Repository Structure

* **`server.js`**: Core Node.js HTTP server. Serves static frontend files and hosts the `/api/` endpoints that handle real-time scraping, payload decoding, caching, and category mapping.
* **`index.html`**: The entire frontend interface. Includes the age verification splash modal, navigation sidebar, autocomplete search bar, video grid layouts, and the modal iframe video player.
* **`index.css`**: Styling definition for the dark-mode layout, layout toggle variables, media queries, and slide/fade transitions.
* **`out/`**: Target directory for replicated/generated static pages.

---

## 💰 Monetization & Ad Spaces

This site is pre-configured with ad placement containers matching standard ad formats:
- **Leaderboard (728x90)**: Located at the top header and inside the video detail player modal.
- **Skyscrapers (160x600)**: Left and right ad rails (desktop only).
- **Medium Rectangle (300x250) & Half Page (300x600)**: Inside the right sidebar.

> [!WARNING]
> **Do not use Google AdSense.**
> Explicit/adult content violates Google Publisher Policies. Instead, integrate compatible adult ad networks such as ExoClick, JuicyAds, TrafficStars, or Adsterra.

---

## ⚖️ Legal & Age Filtering (RTA Label)

This website uses the **Restricted To Adults (RTA)** site label to assist parental filtering tools. All content is protected under ASACP guidelines and complies with standard adult content disclaimer protocols. Access is strictly limited to individuals 18+ or the legal age of majority in your jurisdiction.
