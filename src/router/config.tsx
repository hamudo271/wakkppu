import type { RouteObject } from "react-router-dom";
import NotFound from "../pages/NotFound";
import Home from "../pages/home/page";
import Wakbbu from "../pages/wakbbu/page";
import King from "../pages/king/page";

const routes: RouteObject[] = [
  {
    path: "/",
    element: <Home />,
  },
  {
    path: "/wakbbu",
    element: <Wakbbu />,
  },
  {
    path: "/king",
    element: <King />,
  },
  {
    path: "*",
    element: <NotFound />,
  },
];

export default routes;
