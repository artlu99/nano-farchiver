/** @type {import("tailwindcss").Config} */
export default {
	content: ["./index.html", "./**/*.{ts,tsx,js,jsx}"],
	plugins: [require("daisyui")],
	daisyui: {
		themes: ["dark"],
	},
};
