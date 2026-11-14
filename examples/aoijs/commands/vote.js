// like module.exports in aoi.js: an object or an array of objects
module.exports = [
  { name: "vote", code: "$title[Vote]$description[Pizza tonight?]$addButton[no;yes;Yes;success]$addButton[no;no;No;danger]" },
  { name: "yes", type: "interactionCommand", code: "$username voted yes" },
];
