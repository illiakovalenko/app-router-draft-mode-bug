import { IncomingHttpHeaders } from "http";
import { cookies as nextCookies, draftMode } from "next/headers";
import { NextRequest } from "next/server";
import { SERVER_PROPS_ID, STATIC_PROPS_ID } from "next/constants";
import { NextApiRequest } from "next";

const PreviewCookies = {
  PREVIEW_DATA: "__next_preview_data",
  PRERENDER_BYPASS: "__prerender_bypass",
};

export const resolveServerUrl = (req: NextApiRequest | NextRequest) => {
  // to preserve auth headers, use https if we're in our 3 main hosting options
  const useHttps = (process.env.VERCEL || process.env.NETLIFY) !== undefined;
  const host = (req.headers as Headers).get
    ? (req.headers as Headers).get("x-forwarded-host") ||
      (req.headers as Headers).get("host")
    : (req as NextApiRequest).headers["x-forwarded-host"] ||
      (req as NextApiRequest).headers.host;

  // use https for requests with auth but also support unsecured http rendering hosts
  return `${useHttps ? "https" : "http"}://${host}`;
};

export const cleanupNextPreviewCookies = (
  cookies: string | string[] | null
) => {
  if (!cookies) {
    return null;
  }
  if (!Array.isArray(cookies)) {
    cookies = cookies.split(",");
  }
  // Filter out Next.js preview cookies
  const filteredCookies = cookies.filter(
    (cookie: string) =>
      !new RegExp(`^${PreviewCookies.PREVIEW_DATA}=`).test(cookie) &&
      !new RegExp(`^${PreviewCookies.PRERENDER_BYPASS}=`).test(cookie)
  );
  return filteredCookies;
};

export const getQueryParamsForPropagation = (
  query: Partial<{ [key: string]: string | string[] }>
): { [key: string]: string } => {
  const params: { [key: string]: string } = {};
  if (query["x-vercel-protection-bypass"]) {
    params["x-vercel-protection-bypass"] = query[
      "x-vercel-protection-bypass"
    ] as string;
  }
  if (query["x-vercel-set-bypass-cookie"]) {
    params["x-vercel-set-bypass-cookie"] = query[
      "x-vercel-set-bypass-cookie"
    ] as string;
  }
  return params;
};

export const EDITING_PASS_THROUGH_HEADERS = ["authorization", "cookie"];

/**
 * Get headers that should be passed along to subsequent requests
 * @param {IncomingHttpHeaders} headers Incoming HTTP Headers
 * @returns Object of approved headers
 * @internal
 */
export const getHeadersForPropagation = (
  headers: IncomingHttpHeaders | Headers
): { [key: string]: string } => {
  // Filter and normalize headers
  const filteredHeaders = EDITING_PASS_THROUGH_HEADERS.reduce((acc, header) => {
    const value = (headers as Headers).get
      ? (headers as Headers).get(header)
      : (headers as IncomingHttpHeaders)[header];
    if (value) {
      acc[header] = Array.isArray(value) ? value.join(", ") : value;
    }
    return acc;
  }, {} as Record<string, string>);

  return filteredHeaders;
};

export const GET = async (request: NextRequest) => {
  console.log("Preview request received from: ", resolveServerUrl(request));
  const draft = await draftMode();
  const headers = request.headers;
  const responseHeaders: { [key: string]: string } = {};
  const query: { [key: string]: string } = {};
  request.nextUrl.searchParams.forEach((value: string, key: string) => {
    query[key] = value;
  });

  try {
    console.log("Draft mode enabled");
    draft.enable();

    const requestUrl = new URL("/", resolveServerUrl(request));

    const cookieStore = await nextCookies();

    cookieStore.set(
      PreviewCookies.PRERENDER_BYPASS,
      cookieStore.get(PreviewCookies.PRERENDER_BYPASS)?.value || "",
      {
        httpOnly: true,
        path: "/",
        sameSite: "none",
        secure: true,
      }
    );

    const propagatedQsParams = getQueryParamsForPropagation(query);
    const propagatedHeaders = getHeadersForPropagation(headers);
    const convertedCookies = cookieStore
      .getAll()
      .map((c: { name: string; value: string }) => `${c.name}=${c.value}`);

    // Get the page

    for (const key in propagatedQsParams) {
      if (
        {}.hasOwnProperty.call(propagatedQsParams, key) &&
        propagatedQsParams[key]
      ) {
        requestUrl.searchParams.append(key, propagatedQsParams[key]);
      }
    }

    requestUrl.searchParams.append('route', '/');
    requestUrl.searchParams.append('item_id', '{00000000-0000-0000-0000-000000000000}');
    requestUrl.searchParams.append('language', 'en');
    requestUrl.searchParams.append("timestamp", Date.now().toString());

    // Grab the Next.js preview cookies to send on to the render request
    propagatedHeaders.cookie = `${
      propagatedHeaders.cookie ? propagatedHeaders.cookie + ";" : ""
    }${convertedCookies.join(";")}`;

    console.log("Request URL: ", requestUrl.toString());
    console.log("Propagated headers: ", propagatedHeaders);

    let html = await fetch(requestUrl.toString(), {
      credentials: "include",
      headers: propagatedHeaders,
      method: "GET",
    })
    .then((response) => {
      console.log("Response: ", response);
      return response.text();
    })
    .catch((error) => {
      console.error("Error fetching page: ", error);
      // We need to handle not found error provided by Vercel
      // for `fallback: false` pages
      if (error.response.status === 404) {
        console.error("Page not found: ", error.response);
        return error.response;
      }

      throw error;
    });

    console.log("HTML: ", html);

    if (!html || html.length === 0) {
      throw new Error(`Failed to render html for ${requestUrl.toString()}`);
    }

    // replace phkey attribute with key attribute so that newly added renderings
    // show correct placeholders, so save and refresh won't be needed after adding each rendering
    html = html.replace(new RegExp("phkey", "g"), "key");

    // When SSG, Next will attempt to perform a router.replace on the client-side to inject the query string parms
    // to the router state. See https://github.com/vercel/next.js/blob/v10.0.3/packages/next/client/index.tsx#L169.
    // However, this doesn't really work since at this point we're in the editor and the location.search has nothing
    // to do with the Next route/page we've rendered. Beyond the extraneous request, this can result in a 404 with
    // certain route configurations (e.g. multiple catch-all routes).
    // The following line will trick it into thinking we're SSR, thus avoiding any router.replace.
    html = html.replace(STATIC_PROPS_ID, SERVER_PROPS_ID);

    console.log('Converted cookies: ', convertedCookies);

    // remove nextjs preview cookies to not leak them to the browser
    const filteredCookies = cleanupNextPreviewCookies(convertedCookies);
    console.log('Filtered cookies: ', filteredCookies);
    responseHeaders["Set-Cookie"] = filteredCookies?.join("; ") || "";
    responseHeaders["Content-Type"] = "text/html; charset=utf-8";

    console.log('Response headers: ', responseHeaders);

    return new Response(html, { status: 200, headers: responseHeaders });
  } catch (error) {
    console.error(error);
    return new Response(null, { status: 500 });
  } finally {
    draft.disable();
  }
};
