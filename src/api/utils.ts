import { Response } from "express";

export const sendSuccessfulResponse = async (
  response: Response<any>,
  data: any = {}
): Promise<void> => {
  response.send({
    status: "ok",
    data: data,
  });
};

export const sendErrorResponse = async (
  response: Response<any>,
  message: string
): Promise<void> => {
  response.send({
    status: "error",
    message: message,
  });
};
