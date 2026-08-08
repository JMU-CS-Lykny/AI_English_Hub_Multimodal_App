"use client";

import { useEffect, useState } from "react";
import MascotChat from "@/components/MascotChat";
import { getUser } from "@/lib/auth";

/** Floating mascot for authenticated students on /home and student routes. */
export default function StudentMascotHost() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const user = getUser();
    setShow(user?.role === "STUDENT");
  }, []);

  if (!show) return null;
  return <MascotChat variant="floating" />;
}
