class ImageMarquee extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    const rawImages = (this.getAttribute('images') || '').split(',').map(s => s.trim()).filter(Boolean);
    const speed = this.getAttribute('speed') || '120s';

    if (rawImages.length === 0) return;

    let imageList = [...rawImages];
    while (imageList.length < 10) {
      imageList = imageList.concat(rawImages);
    }

    const renderGroup = (ariaHidden = false) => `
      <div class="group" ${ariaHidden ? 'aria-hidden="true"' : ''}>
        ${imageList.map(src => `<img src="${src}" alt="Marquee logo" />`).join('')}
      </div>
    `;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          box-sizing: border-box;
        }

        .marquee-wrapper {
          display: flex;
          width: 100%;
          overflow: hidden;
          user-select: none;
          padding: 1em 0;
        }

        .marquee-track {
          display: flex;
          flex-shrink: 0;
          min-width: 100%;
          animation: scroll ${speed} linear infinite;
        }

        .marquee-wrapper:hover .marquee-track {
          /* animation-play-state: paused; */
        }

        .group {
          display: flex;
          align-items: center;
          justify-content: space-around;
          /* gap: 0.1rem; */
          /* padding-right: 0.1rem; */
          flex-shrink: 0;
        }

        img {
          height: 500px;
          width: auto;
          object-fit: contain;

          /* Feathers ONLY the left and right edges flat (no oval/circle shapes) */
          -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 5%,
            black 95%,
            transparent 100%
          );
          mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 5%,  /* Shorter and sharper feathering: Change 15% / 85% to 5% / 95% */
                       /* Deeper  and softer  feathering: Change 15% / 85% to 25% / 75% */
            black 95%,
            transparent 100%
          );
        }

          image-marquee {
            display: block;
            height: 60px; /* Adjust as needed */
            max-height: 60px;
          }

        @keyframes scroll {
          0% {
            transform: translateX(0%);
          }
          100% {
            transform: translateX(-100%);
          }
        }
      </style>

      <div class="marquee-wrapper">
        <div class="marquee-track">
          ${renderGroup(false)}
        </div>
        <div class="marquee-track">
          ${renderGroup(true)}
        </div>
      </div>
    `;
  }
}

customElements.define('image-marquee', ImageMarquee);
