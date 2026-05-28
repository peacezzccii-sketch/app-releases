import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  try {
    const store = getStore('analytics');
    const count = await store.get('total_downloads');
    
    return new Response(JSON.stringify({ 
      count: count === null ? 0 : parseInt(count, 10) 
    }), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    console.error("Error in get-stats:", error);
    return new Response(JSON.stringify({ count: 0, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export const config = {
  path: "/get-stats"
};
