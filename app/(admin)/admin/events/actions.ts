"use server";

import { revalidatePath } from "next/cache";
import { requireAdminRole } from "@/lib/auth/admin";
import { assertAdminServerActionCsrf } from "@/lib/auth/adminCsrf";
import { ApiError } from "@/lib/http/errors";
import {
  createCategory,
  createEvent,
  createSalesPhase,
  createVenue,
  updateCategory,
  updateEvent,
  updateSalesPhase,
} from "@/lib/admin/catalog";
import type { AdminActionState } from "@/lib/admin/actionState";
import {
  categoryMutationSchema,
  eventMutationSchema,
  salesPhaseMutationSchema,
  venueMutationSchema,
} from "@/lib/validation/catalog";
import type { output, ZodType } from "zod";

function formValues(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function validationError<TSchema extends ZodType>(
  schema: TSchema,
  values: Record<string, FormDataEntryValue>,
): { success: true; data: output<TSchema> } | { success: false; message: string } {
  const result = schema.safeParse(values);
  if (result.success) return { success: true, data: result.data as output<TSchema> };
  return {
    success: false as const,
    message: result.error.issues[0]?.message ?? "Données invalides",
  };
}

function failure(error: unknown): AdminActionState {
  if (error instanceof ApiError) {
    return { status: "error", message: error.message };
  }
  console.error("Admin catalogue mutation failed", error);
  return { status: "error", message: "Une erreur interne est survenue" };
}

async function authorizeMutation(formData: FormData) {
  const admin = await requireAdminRole(["super_admin", "admin"]);
  await assertAdminServerActionCsrf(formData);
  return admin.id;
}

export async function createVenueAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(venueMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    await createVenue(parsed.data, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Lieu créé" };
  } catch (error) {
    return failure(error);
  }
}

export async function createEventAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(eventMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    await createEvent(parsed.data, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Événement créé" };
  } catch (error) {
    return failure(error);
  }
}

export async function updateEventAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(eventMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    if (!parsed.data.eventId) return { status: "error", message: "Événement manquant" };
    await updateEvent({ ...parsed.data, eventId: parsed.data.eventId }, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Événement mis à jour" };
  } catch (error) {
    return failure(error);
  }
}

export async function createCategoryAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(categoryMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    await createCategory(parsed.data, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Catégorie créée" };
  } catch (error) {
    return failure(error);
  }
}

export async function updateCategoryAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(categoryMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    if (!parsed.data.categoryId) return { status: "error", message: "Catégorie manquante" };
    await updateCategory({ ...parsed.data, categoryId: parsed.data.categoryId }, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Catégorie mise à jour" };
  } catch (error) {
    return failure(error);
  }
}

export async function createSalesPhaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(salesPhaseMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    await createSalesPhase(parsed.data, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Phase créée" };
  } catch (error) {
    return failure(error);
  }
}

export async function updateSalesPhaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    const adminId = await authorizeMutation(formData);
    const parsed = validationError(salesPhaseMutationSchema, formValues(formData));
    if (!parsed.success) return { status: "error", message: parsed.message };
    if (!parsed.data.phaseId) return { status: "error", message: "Phase manquante" };
    await updateSalesPhase({ ...parsed.data, phaseId: parsed.data.phaseId }, adminId);
    revalidatePath("/admin", "layout");
    return { status: "success", message: "Phase mise à jour" };
  } catch (error) {
    return failure(error);
  }
}
